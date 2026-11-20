import { Api } from "teleproto";
import { eq, and } from "drizzle-orm";
import { TelegramClientService } from "./TelegramClientService";
import { TelegramUtils } from "./TelegramUtils";
import { DatabaseClient } from "../database/DatabaseClient";
import { SessionStatus } from "../database/constants/SessionStatus";
import {
	SessionCallbackService,
	type SessionLifecycleReason,
} from "../services/SessionCallbackService";
import { telegramSessions } from "../database/schema";

interface TelegramSessionRecord {
	id: bigint;
	session_id: string;
	telegram_user_id: string;
	callback_url: string;
}

/**
 * Periodically scans the session pool and the database to keep live
 * Telegram connections in a healthy state.
 *
 * Three scenarios are handled on every tick:
 *
 * 1. **Stale pool entry** — a session is pooled but the user has logged out
 *    (e.g. revoked from another device). The client is destroyed, removed from
 *    the pool, and the database record is marked as revoked.
 *
 * 2. **Stalled session** — a session is pooled and authorized, but its update
 *    position stays behind the server for several minutes. It is disconnected
 *    so the owner can reconnect, unless most of the pool is behind, which
 *    points to a Telegram issue rather than to one session.
 *
 * 3. **Dead session** — a session is active in the database but absent from
 *    the pool (e.g. the process crashed and restarted without a full restore,
 *    or the connection dropped silently). The session is re-initialized and
 *    added back to the pool automatically, unless its credential error is
 *    already confirmed: then only its disconnect callback is sent again
 *    until Chat-X accepts it.
 *
 * The check interval is controlled by `WATCHDOG_INTERVAL_SECONDS` in the
 * environment file (default: 60 seconds).
 */
const REVOKE_AFTER_FAILING_MS = 3 * 60_000;
const REVOKE_AFTER_FAILED_CHECKS = 3;

const STALL_CONFIRM_MS = 5 * 60_000;
const TICK_OVERRUN_LOG_INTERVAL_MS = 5 * 60_000;
const REPEATED_LOG_INTERVAL_MS = 10 * 60_000;

/**
 * Upper bound for a single authorization probe. A hung probe would otherwise
 * stall the entire watchdog, since ticks are serialised by the `busy` guard.
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Credential errors (logged out, revoked session, invalid/duplicated auth
 * key) are definitive verdicts from Telegram, so they get a short bounded
 * confirmation — at most {@link CREDENTIAL_MAX_RETRIES} retries spaced
 * {@link CREDENTIAL_RETRY_DELAY_MS} apart — after which the session is
 * reported to Chat-X as disconnected and, once that callback is accepted,
 * invalidated. Until it is accepted the session stays and only the callback
 * is sent again on the next tick; the confirmation is not repeated.
 */
const CREDENTIAL_MAX_RETRIES = 2;
const CREDENTIAL_RETRY_DELAY_MS = 5_000;

/** Result of a single authorization probe. */
type ProbeOutcome = "authorized" | "credential_error" | "transient_error";

interface SessionInfo {
	callback_url: string;
	telegram_user_id: string;
}

export class TelegramSessionWatchdog {
	private timer: ReturnType<typeof setInterval> | null = null;

	/** Whether a health-check tick is currently in progress. */
	private busy = false;

	private tickStartedAt = 0;

	private readonly serverPositions = new Map<string, number>();

	private readonly confirmedCredentialErrors = new Set<string>();

	private readonly stallTrackers = new Map<
		string,
		{ localPosition: number; stalledSince: number }
	>();

	private readonly lastLoggedAt = new Map<string, number>();

	/**
	 * Tracks the current run of authorization-probe failures per session: the
	 * time it failed alone, how many checks failed, and when the last counted
	 * check ran (absent while the run is paused by a network outage).
	 */
	private readonly failureRuns = new Map<
		string,
		{
			failingMilliseconds: number;
			failedChecks: number;
			lastCountedAt: number | undefined;
		}
	>();

	/** Last lifecycle reason emitted per session, used to avoid callback spam. */
	private readonly lastEmittedReason = new Map<string, SessionLifecycleReason>();

	/**
	 * Starts the watchdog timer.
	 * Safe to call multiple times — calling start on an already-running
	 * watchdog is a no-op.
	 */
	start(): void {
		if (this.timer) return;

		const intervalSec = Math.max(
			1,
			parseInt(process.env.WATCHDOG_INTERVAL_SECONDS ?? "60", 10),
		);

		this.timer = setInterval(() => {
			this.tick().catch((error) => {
				console.error("[Watchdog] Unhandled error during tick:", error);
			});
		}, intervalSec * 1000);

		console.log(`[Watchdog] Started — interval: ${intervalSec}s`);
	}

	/** Stops the watchdog timer. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
			console.log("[Watchdog] Stopped");
		}
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Single watchdog tick.
	 * Guards against overlapping ticks if a previous one is still running.
	 */
	private async tick(): Promise<void> {
		if (this.busy) {
			const runningMs = Date.now() - this.tickStartedAt;
			if (runningMs >= TICK_OVERRUN_LOG_INTERVAL_MS) {
				this.logAtMostEvery(
					"tick-overrun",
					TICK_OVERRUN_LOG_INTERVAL_MS,
					"error",
					`[Watchdog] Tick still running after ${Math.round(runningMs / 1000)}s`,
				);
			}
			return;
		}

		this.busy = true;
		this.tickStartedAt = Date.now();
		this.serverPositions.clear();
		try {
			await this.evictLoggedOutSessions();
			await this.disconnectStalledSessions();
			await this.reviveDeadSessions();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Performs a fresh MTProto round-trip to determine whether a session's
	 * auth key is still valid on this tick.
	 *
	 * We deliberately avoid gramjs `isUserAuthorized()`: it memoises its result,
	 * so once a session is observed as unauthorized it never re-checks. That
	 * left the watchdog permanently reporting stale "all sessions failed"
	 * even after the underlying connection recovered. A direct `updates.GetState`
	 * invoke reflects the live state every time.
	 *
	 * Errors are split into two classes: credential errors (401 /
	 * AUTH_KEY_DUPLICATED — a definitive verdict from Telegram, the network
	 * round-trip itself worked) and transient errors (timeouts, flood,
	 * network) which are absorbed by the majority-failure circuit breaker
	 * in the caller.
	 */
	private async probeSession(
		sessionId: string,
		client: TelegramClientService,
	): Promise<ProbeOutcome> {
		try {
			const state = await TelegramUtils.withTimeout(
				client.getClient().invoke(new Api.updates.GetState()),
				PROBE_TIMEOUT_MS,
				"authorization probe timed out",
			);
			this.serverPositions.set(sessionId, state.pts);
			return "authorized";
		} catch (error) {
			return TelegramUtils.isCredentialError(error)
				? "credential_error"
				: "transient_error";
		}
	}

	/**
	 * Re-probes a session that just returned a credential error, up to
	 * {@link CREDENTIAL_MAX_RETRIES} times at {@link CREDENTIAL_RETRY_DELAY_MS}
	 * intervals, returning early as soon as a probe comes back authorized.
	 * The returned outcome is the last probe's result.
	 */
	private async reprobeWithRetries(
		sessionId: string,
		client: TelegramClientService,
	): Promise<ProbeOutcome> {
		let outcome: ProbeOutcome = "credential_error";
		for (let retry = 1; retry <= CREDENTIAL_MAX_RETRIES; retry++) {
			await this.sleep(CREDENTIAL_RETRY_DELAY_MS);
			outcome = await this.probeSession(sessionId, client);
			if (outcome === "authorized") break;
		}
		return outcome;
	}

	/** Resolves after `ms` milliseconds. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Scenario 1: Pool contains a session whose user has logged out.
	 *
	 * First probes every pooled session with `isUserAuthorized()`, then
	 * applies a circuit breaker: if most sessions failed in this tick
	 * the cause is almost certainly a network outage rather than
	 * individual logouts, so the failure runs of the failing sessions are
	 * paused (the outage counts toward neither time nor checks, what was
	 * counted before is kept), the run of a session that passed is cleared,
	 * and no sessions are evicted.
	 *
	 * Individual failures are tracked as a run of failed checks; a session is
	 * only revoked once the run has failed for {@link REVOKE_AFTER_FAILING_MS}
	 * and holds at least {@link REVOKE_AFTER_FAILED_CHECKS} checks where it
	 * alone (not the whole pool) fails.
	 */
	private async evictLoggedOutSessions(): Promise<void> {
		const pooledIds = TelegramClientService.getPooledSessionIds();
		if (pooledIds.length === 0) return;

		const results = new Map<string, ProbeOutcome>();

		// Probe all sessions concurrently. Each check is an MTProto round-trip,
		// so running 100+ sequentially would make a single tick take far longer
		// than the watchdog interval.
		await Promise.all(
			pooledIds.map(async (sessionId) => {
				const client = TelegramClientService.getFromPool(sessionId);
				if (!client) return;

				results.set(sessionId, await this.probeSession(sessionId, client));
			}),
		);

		// Credential errors are a definitive verdict from Telegram (the network
		// round-trip itself succeeded), so they are exempt from the
		// network-outage circuit breaker and the slow failure-run
		// tracking below. Confirm with a short bounded retry, then revoke once
		// Chat-X accepts the disconnect callback. Without the confirmation a
		// mass logout would trip the breaker and loop forever.
		for (const [sessionId, outcome] of [...results]) {
			if (outcome !== "credential_error") {
				this.confirmedCredentialErrors.delete(sessionId);
				continue;
			}
			results.delete(sessionId);

			const client = TelegramClientService.getFromPool(sessionId);
			if (!client) continue;

			const confirmed = this.confirmedCredentialErrors.has(sessionId)
				? "credential_error"
				: await this.reprobeWithRetries(sessionId, client);
			if (confirmed === "credential_error") {
				const revoked = await this.revokeUnauthorizedSession(sessionId);
				this.recordCredentialRevokeOutcome(sessionId, revoked);
				if (revoked) {
					console.log(
						`[Watchdog] Session credential check failed after ${CREDENTIAL_MAX_RETRIES} retries — revoked`,
					);
				}
			} else if (confirmed === "authorized") {
				this.failureRuns.delete(sessionId);
				this.lastEmittedReason.delete(sessionId);
			}
			// transient_error → inconclusive; leave state for the next tick
		}

		const total = results.size;
		const failedCount = [...results.values()].filter(
			(v) => v !== "authorized",
		).length;

		if (failedCount === total && total > 1) {
			this.logAtMostEvery(
				"all-sessions-failed",
				REPEATED_LOG_INTERVAL_MS,
				"warn",
				`[Watchdog] All ${total} sessions failed authorization — likely a network issue, skipping eviction`,
			);
			this.pauseFailureRuns(results);
			return;
		}

		if (total > 2 && failedCount / total > 0.5) {
			this.logAtMostEvery(
				"most-sessions-failed",
				REPEATED_LOG_INTERVAL_MS,
				"warn",
				`[Watchdog] ${failedCount}/${total} sessions failed — likely a network issue, skipping eviction`,
			);
			this.pauseFailureRuns(results);
			return;
		}

		for (const [sessionId, outcome] of results) {
			if (outcome === "authorized") {
				this.failureRuns.delete(sessionId);
				this.lastEmittedReason.delete(sessionId);
				continue;
			}

			const failureRun = this.failureRuns.get(sessionId) ?? {
				failingMilliseconds: 0,
				failedChecks: 0,
				lastCountedAt: undefined,
			};
			if (failureRun.lastCountedAt !== undefined) {
				failureRun.failingMilliseconds +=
					this.tickStartedAt - failureRun.lastCountedAt;
			}
			failureRun.lastCountedAt = this.tickStartedAt;
			failureRun.failedChecks++;
			this.failureRuns.set(sessionId, failureRun);

			if (
				failureRun.failingMilliseconds >= REVOKE_AFTER_FAILING_MS &&
				failureRun.failedChecks >= REVOKE_AFTER_FAILED_CHECKS
			) {
				const revoked = await this.revokeUnauthorizedSession(sessionId);
				if (revoked) {
					this.failureRuns.delete(sessionId);
					this.lastEmittedReason.delete(sessionId);
					console.log(
						`[Watchdog] Session unauthorized ${failureRun.failedChecks} consecutive times — revoked`,
					);
				}
			} else {
				this.logAtMostEvery(
					`authorization-failed:${sessionId}`,
					REPEATED_LOG_INTERVAL_MS,
					"warn",
					`[Watchdog] Session authorization check failed (failed checks: ${failureRun.failedChecks}, failing for ${Math.round(failureRun.failingMilliseconds / 1000)}s)`,
				);
			}
		}
	}

	private pauseFailureRuns(results: Map<string, ProbeOutcome>): void {
		for (const [sessionId, outcome] of results) {
			const failureRun = this.failureRuns.get(sessionId);
			if (!failureRun) continue;
			if (outcome === "authorized") this.failureRuns.delete(sessionId);
			else failureRun.lastCountedAt = undefined;
		}
	}

	private async disconnectStalledSessions(): Promise<void> {
		const pooledIds = TelegramClientService.getPooledSessionIds();
		const now = Date.now();
		const confirmedStalls: {
			sessionId: string;
			localPosition: number;
			serverPosition: number;
			stalledForSeconds: number;
		}[] = [];

		for (const sessionId of this.stallTrackers.keys()) {
			if (!pooledIds.includes(sessionId)) this.stallTrackers.delete(sessionId);
		}

		for (const logKey of this.lastLoggedAt.keys()) {
			const separatorIndex = logKey.indexOf(":");
			if (
				separatorIndex !== -1 &&
				!pooledIds.includes(logKey.slice(separatorIndex + 1))
			) {
				this.lastLoggedAt.delete(logKey);
			}
		}

		let probeFailedCount = 0;
		for (const sessionId of pooledIds) {
			const serverPosition = this.serverPositions.get(sessionId);
			if (serverPosition === undefined) {
				this.stallTrackers.delete(sessionId);
				probeFailedCount++;
				continue;
			}

			const client = TelegramClientService.getFromPool(sessionId)?.getClient();
			const localPosition = client?.updateManager.state?.pts;
			if (localPosition === undefined || serverPosition <= localPosition) {
				this.stallTrackers.delete(sessionId);
				continue;
			}

			const tracker = this.stallTrackers.get(sessionId);
			if (!tracker || tracker.localPosition !== localPosition) {
				this.stallTrackers.set(sessionId, {
					localPosition,
					stalledSince: now,
				});
				void client?.catchUp();
				const behindLogKey = `behind:${sessionId}`;
				if (this.isLogDue(behindLogKey, REPEATED_LOG_INTERVAL_MS)) {
					const behindInfo = await this.resolveSessionInfo(sessionId).catch(
							(error) => {
								console.warn(
									`[Watchdog] Session lookup for the catch-up log line failed: ${error instanceof Error ? error.message : error}`,
								);
								return null;
							},
						);
					if (behindInfo) {
						this.logAtMostEvery(
							behindLogKey,
							REPEATED_LOG_INTERVAL_MS,
							"warn",
							`[Watchdog] Session user=${behindInfo.telegram_user_id} is behind the server (local pts=${localPosition}, server pts=${serverPosition}) — requesting catch-up`,
						);
					}
				}
				continue;
			}

			if (now - tracker.stalledSince >= STALL_CONFIRM_MS) {
				confirmedStalls.push({
					sessionId,
					localPosition,
					serverPosition,
					stalledForSeconds: Math.round((now - tracker.stalledSince) / 1000),
				});
			}
		}

		const behindCount = this.stallTrackers.size + probeFailedCount;
		if (
			confirmedStalls.length > 0 &&
			pooledIds.length > 2 &&
			behindCount / pooledIds.length > 0.5
		) {
			this.logAtMostEvery(
				"stalled-majority",
				REPEATED_LOG_INTERVAL_MS,
				"warn",
				`[Watchdog] ${behindCount}/${pooledIds.length} sessions stopped receiving updates — likely a Telegram issue, skipping`,
			);
			return;
		}

		for (const stalled of confirmedStalls) {
			const info = await this.resolveSessionInfo(stalled.sessionId);
			if (!info) {
				this.logAtMostEvery(
					`stalled-without-record:${stalled.sessionId}`,
					REPEATED_LOG_INTERVAL_MS,
					"warn",
					"[Watchdog] Stalled session has no session record — cannot notify or revoke",
				);
				continue;
			}

			this.logAtMostEvery(
				`stalled:${stalled.sessionId}`,
				REPEATED_LOG_INTERVAL_MS,
				"warn",
				`[Watchdog] Session user=${info.telegram_user_id} stopped receiving updates for ${stalled.stalledForSeconds}s (local pts=${stalled.localPosition}, server pts=${stalled.serverPosition}) — disconnecting`,
			);
			await this.disconnectThenRevoke(
				stalled.sessionId,
				info,
				"receiving_updates_stalled",
			);
		}
	}

	private recordCredentialRevokeOutcome(
		sessionId: string,
		revoked: boolean,
	): void {
		if (revoked) {
			this.failureRuns.delete(sessionId);
			this.lastEmittedReason.delete(sessionId);
			this.confirmedCredentialErrors.delete(sessionId);
		} else {
			this.confirmedCredentialErrors.add(sessionId);
		}
	}

	private async revokeUnauthorizedSession(sessionId: string): Promise<boolean> {
		const info = await this.resolveSessionInfo(sessionId);
		if (!info) {
			await TelegramClientService.invalidate(sessionId, "authorization_check_failed");
			return true;
		}
		return this.disconnectThenRevoke(sessionId, info, "authorization_check_failed");
	}

	private async disconnectThenRevoke(
		sessionId: string,
		info: SessionInfo,
		reason: SessionLifecycleReason,
	): Promise<boolean> {
		const accepted = await SessionCallbackService.notify(
			info.callback_url,
			"telegram_session_disconnected",
			sessionId,
			info.telegram_user_id,
			"disconnected",
			reason,
		);

		if (!accepted) {
			this.logAtMostEvery(
				`callback-not-accepted:${sessionId}`,
				REPEATED_LOG_INTERVAL_MS,
				"warn",
				`[Watchdog] Disconnect callback not accepted for user=${info.telegram_user_id} — retrying next tick`,
			);
			return false;
		}

		await TelegramClientService.invalidate(sessionId, reason);
		return true;
	}

	private logAtMostEvery(
		key: string,
		intervalMs: number,
		level: "warn" | "error",
		message: string,
	): void {
		if (!this.isLogDue(key, intervalMs)) return;

		this.lastLoggedAt.set(key, Date.now());
		console[level](message);
	}

	private isLogDue(key: string, intervalMs: number): boolean {
		const lastLoggedAt = this.lastLoggedAt.get(key);
		return lastLoggedAt === undefined || Date.now() - lastLoggedAt >= intervalMs;
	}

	/**
	 * Scenario 3: Database has an active session that is not in the pool.
	 *
	 * Queries the database for all active sessions belonging to this server
	 * and re-initializes any that are missing from the pool, except a session
	 * with an already confirmed credential error, which only gets its
	 * disconnect callback sent again until Chat-X accepts it.
	 */
	private async reviveDeadSessions(): Promise<void> {
		const serverName = process.env.SERVER_NAME ?? "";
		if (!serverName) return;

		let activeSessions: TelegramSessionRecord[];

		try {
			activeSessions = await DatabaseClient.getInstance().execute(
				(db) =>
					db
						.select({
							id: telegramSessions.id,
							session_id: telegramSessions.session_id,
							telegram_user_id: telegramSessions.telegram_user_id,
							callback_url: telegramSessions.callback_url,
						})
						.from(telegramSessions)
						.where(
							and(
								eq(telegramSessions.status, SessionStatus.ACTIVE),
								eq(telegramSessions.server_name, serverName),
							),
						),
			);
		} catch (error) {
			console.error("[Watchdog] Failed to query active sessions:", error);
			return;
		}

		for (const session of activeSessions) {
			if (TelegramClientService.isPooled(session.session_id)) continue;

			if (this.confirmedCredentialErrors.has(session.session_id)) {
				const revoked = await this.disconnectThenRevoke(
					session.session_id,
					session,
					"authorization_check_failed",
				);
				this.recordCredentialRevokeOutcome(session.session_id, revoked);
				continue;
			}

			console.log(
				`[Watchdog] Session id=${session.id} is active in DB but not pooled — Reconnecting`,
			);

			if (
				session.callback_url &&
				this.lastEmittedReason.get(session.session_id) !== "reconnecting"
			) {
				await SessionCallbackService.notify(
					session.callback_url,
					"telegram_session_disconnected",
					session.session_id,
					session.telegram_user_id,
					"reconnecting",
					"reconnecting",
				);
				this.lastEmittedReason.set(session.session_id, "reconnecting");
			}

			try {
				const client = await this.initializeWithCredentialRetry(
					session.session_id,
				);
				TelegramClientService.addToPool(
					session.session_id,
					client,
					session.telegram_user_id,
				);
				this.lastEmittedReason.delete(session.session_id);
				console.log(
					`[Watchdog] Session id=${session.id} reconnect successfully`,
				);
			} catch (error) {
				console.error(
					`[Watchdog] Failed to reconnect session id=${session.id}:`,
					error,
				);

				// Credential errors survived the bounded retries above — the
				// session is dead for good. Tell Chat-X it is disconnected, and
				// only once that callback is accepted remove the session (the
				// ACTIVE database row, so the revive loop stops picking it up).
				// Otherwise keep it and try again next tick.
				if (TelegramUtils.isCredentialError(error)) {
					const revoked = await this.disconnectThenRevoke(
						session.session_id,
						session,
						"authorization_check_failed",
					);
					this.recordCredentialRevokeOutcome(session.session_id, revoked);
					if (revoked) {
						console.log(
							`[Watchdog] Session id=${session.id} has dead credentials after ${CREDENTIAL_MAX_RETRIES} retries — revoked`,
						);
					}
					continue;
				}

				if (
					session.callback_url &&
					this.lastEmittedReason.get(session.session_id) !==
						"reconnect_failed"
				) {
					await SessionCallbackService.notify(
						session.callback_url,
						"telegram_session_disconnected",
						session.session_id,
						session.telegram_user_id,
						"disconnected",
						"reconnect_failed",
					);
					this.lastEmittedReason.set(
						session.session_id,
						"reconnect_failed",
					);
				}
			}
		}
	}

	/**
	 * Connects a session, retrying credential errors up to
	 * {@link CREDENTIAL_MAX_RETRIES} times at {@link CREDENTIAL_RETRY_DELAY_MS}
	 * intervals. Non-credential errors (network, timeouts) are thrown
	 * immediately — the regular per-tick revive cadence already retries those.
	 * If the retries are exhausted the last credential error is thrown, which
	 * the caller treats as terminal.
	 */
	private async initializeWithCredentialRetry(
		sessionId: string,
	): Promise<TelegramClientService> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await TelegramClientService.initialize(sessionId);
			} catch (error) {
				if (
					!TelegramUtils.isCredentialError(error) ||
					attempt >= CREDENTIAL_MAX_RETRIES
				) {
					throw error;
				}
				console.warn(
					`[Watchdog] Credential error on reconnect — retry ${attempt + 1}/${CREDENTIAL_MAX_RETRIES} in ${CREDENTIAL_RETRY_DELAY_MS / 1000}s`,
				);
				await this.sleep(CREDENTIAL_RETRY_DELAY_MS);
			}
		}
	}

	private async resolveSessionInfo(
		sessionId: string,
	): Promise<SessionInfo | null> {
		const rows = await DatabaseClient.getInstance().execute((db) =>
			db
				.select({
					callback_url: telegramSessions.callback_url,
					telegram_user_id: telegramSessions.telegram_user_id,
				})
				.from(telegramSessions)
				.where(
					and(
						eq(telegramSessions.session_id, sessionId),
						eq(
							telegramSessions.server_name,
							process.env.SERVER_NAME ?? "",
						),
					),
				)
				.limit(1),
		);
		return rows[0] ?? null;
	}
}
