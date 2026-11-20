import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api } from "teleproto";

vi.hoisted(() => {
	process.env.SERVER_NAME = "test-server";
});

const sessionRows: Record<string, unknown>[] = [];
let pendingLookupFailures = 0;

vi.mock("../../src/database/DatabaseClient", () => ({
	DatabaseClient: {
		getInstance: () => ({
			execute: () => {
				if (pendingLookupFailures > 0) {
					pendingLookupFailures--;
					return Promise.reject(new Error("database unavailable"));
				}
				return Promise.resolve(sessionRows);
			},
		}),
	},
}));

vi.mock("../../src/services/SessionCallbackService", () => ({
	SessionCallbackService: { notify: vi.fn() },
}));

vi.mock("../../src/telegram/TelegramClientService", () => ({
	TelegramClientService: {
		getPooledSessionIds: vi.fn(),
		getFromPool: vi.fn(),
		isPooled: vi.fn(),
		invalidate: vi.fn(),
		initialize: vi.fn(),
		addToPool: vi.fn(),
	},
}));

import { SessionCallbackService } from "../../src/services/SessionCallbackService";
import { TelegramClientService } from "../../src/telegram/TelegramClientService";
import { TelegramSessionWatchdog } from "../../src/telegram/TelegramSessionWatchdog";

interface FakeSession {
	serverPosition: number;
	localPosition: number | undefined;
	probeError: Error | undefined;
	catchUp: () => Promise<void>;
}

const sessions = new Map<string, FakeSession>();

function addSession(
	sessionId: string,
	serverPosition: number,
	localPosition: number | undefined,
): FakeSession {
	const session: FakeSession = {
		serverPosition,
		localPosition,
		probeError: undefined,
		catchUp: vi.fn(async () => {}),
	};
	sessions.set(sessionId, session);
	sessionRows.push({
		id: BigInt(sessionRows.length + 1),
		session_id: sessionId,
		telegram_user_id: `user-${sessionId}`,
		callback_url: `https://example.com/${sessionId}`,
	});
	return session;
}

function fakeClientOf(session: FakeSession) {
	return {
		getClient: () => ({
			invoke: async () => {
				if (session.probeError) throw session.probeError;
				return new Api.updates.State({
					pts: session.serverPosition,
					qts: 0,
					date: 0,
					seq: 0,
					unreadCount: 0,
				});
			},
			catchUp: () => session.catchUp(),
			updateManager: {
				state:
					session.localPosition === undefined
						? undefined
						: { pts: session.localPosition },
			},
		}),
	};
}

const notify = vi.mocked(SessionCallbackService.notify);
const invalidate = vi.mocked(TelegramClientService.invalidate);

const MINUTE_MS = 60_000;

function runTick(watchdog: TelegramSessionWatchdog): Promise<void> {
	return (watchdog as unknown as { tick: () => Promise<void> }).tick();
}

async function tickAfter(watchdog: TelegramSessionWatchdog, minutes: number) {
	await vi.advanceTimersByTimeAsync(minutes * MINUTE_MS);
	await runTick(watchdog);
}

function logLinesContaining(spy: ReturnType<typeof vi.spyOn>, text: string) {
	return spy.mock.calls.filter(([line]) => String(line).includes(text));
}

function prepareWatchdogEnvironment(): void {
	vi.useFakeTimers();
	vi.clearAllMocks();
	sessions.clear();
	sessionRows.length = 0;
	pendingLookupFailures = 0;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.mocked(TelegramClientService.getPooledSessionIds).mockImplementation(() => [
		...sessions.keys(),
	]);
	vi.mocked(TelegramClientService.getFromPool).mockImplementation(
		(sessionId: string) => fakeClientOf(sessions.get(sessionId)!) as never,
	);
	vi.mocked(TelegramClientService.isPooled).mockReturnValue(true);
	notify.mockResolvedValue(true);
	invalidate.mockResolvedValue(true);
}

describe("TelegramSessionWatchdog stalled sessions", () => {
	let watchdog: TelegramSessionWatchdog;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		prepareWatchdogEnvironment();
		watchdog = new TelegramSessionWatchdog();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("never flags a session whose position matches the server", async () => {
		addSession("quiet", 100, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 10);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("disconnects a session after five minutes behind the server", async () => {
		addSession("stalled", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 4);
		expect(notify).not.toHaveBeenCalled();

		await tickAfter(watchdog, 1);

		expect(notify).toHaveBeenCalledWith(
			"https://example.com/stalled",
			"telegram_session_disconnected",
			"stalled",
			"user-stalled",
			"disconnected",
			"receiving_updates_stalled",
		);
		expect(invalidate).toHaveBeenCalledWith("stalled", "receiving_updates_stalled");
	});

	it("resets the stall timer when the local position moves", async () => {
		const session = addSession("catching-up", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 4);
		session.localPosition = 101;
		await tickAfter(watchdog, 1);
		await tickAfter(watchdog, 4);
		expect(invalidate).not.toHaveBeenCalled();

		await tickAfter(watchdog, 1);

		expect(invalidate).toHaveBeenCalledWith(
			"catching-up",
			"receiving_updates_stalled",
		);
	});

	it("skips a session without update state", async () => {
		addSession("no-state", 500, undefined);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 10);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("does not evaluate a session whose probe started failing while behind", async () => {
		const session = addSession("probe-failed", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 4);
		session.probeError = new Error("authorization probe timed out");
		for (let minute = 0; minute < 4; minute++) await tickAfter(watchdog, 1);

		expect(invalidate).not.toHaveBeenCalledWith(
			"probe-failed",
			"receiving_updates_stalled",
		);
		expect(notify).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"probe-failed",
			expect.anything(),
			expect.anything(),
			"receiving_updates_stalled",
		);
	});

	it("restarts the stall clock after failed probes", async () => {
		const session = addSession("probe-failed", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 4);
		session.probeError = new Error("authorization probe timed out");
		for (let minute = 0; minute < 3; minute++) await tickAfter(watchdog, 1);
		session.probeError = undefined;
		await tickAfter(watchdog, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await tickAfter(watchdog, 5);

		expect(invalidate).toHaveBeenCalledWith(
			"probe-failed",
			"receiving_updates_stalled",
		);
	});

	it("disconnects the one stalled session among healthy ones", async () => {
		addSession("stalled", 500, 100);
		for (const sessionId of ["healthy-one", "healthy-two", "healthy-three"]) {
			addSession(sessionId, 100, 100);
		}

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("stalled", "receiving_updates_stalled");
	});

	it("disconnects nobody when sessions fall behind on different ticks and most are behind", async () => {
		const sessionIds = Array.from({ length: 10 }, (_, index) => `session-${index}`);
		const fakeSessions = sessionIds.map((sessionId) => addSession(sessionId, 100, 100));
		const fallBehind = (from: number, to: number) => {
			for (const fakeSession of fakeSessions.slice(from, to)) fakeSession.serverPosition = 500;
		};

		fallBehind(0, 3);
		await tickAfter(watchdog, 0);
		fallBehind(3, 6);
		await tickAfter(watchdog, 1);
		fallBehind(6, 10);
		await tickAfter(watchdog, 1);
		for (let minute = 0; minute < 8; minute++) await tickAfter(watchdog, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(
			logLinesContaining(warnSpy, "sessions stopped receiving updates"),
		).toHaveLength(1);
	});

	it("asks a session that falls behind to catch up once", async () => {
		const session = addSession("behind", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 1);
		await tickAfter(watchdog, 1);

		expect(session.catchUp).toHaveBeenCalledTimes(1);
	});

	it("keeps a session whose catch-up brings it level with the server", async () => {
		const session = addSession("recovering", 500, 100);
		session.catchUp = vi.fn(async () => {
			session.localPosition = 500;
		});

		await tickAfter(watchdog, 0);
		for (let minute = 0; minute < 6; minute++) await tickAfter(watchdog, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("disconnects a session that is still behind five minutes after the catch-up request", async () => {
		const session = addSession("hung", 500, 100);
		session.catchUp = vi.fn(() => new Promise<void>(() => {}));

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);

		expect(session.catchUp).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("hung", "receiving_updates_stalled");
	});

	it("notes in the log that the watchdog asks a lagging session to catch up, at most once per ten minutes", async () => {
		const session = addSession("behind", 500, 100);

		for (let minute = 0; minute <= 30; minute++) {
			session.localPosition = 100 + minute;
			await tickAfter(watchdog, minute === 0 ? 0 : 1);
		}

		const lines = logLinesContaining(warnSpy, "is behind the server");
		expect(lines).toHaveLength(4);
		expect(lines[0][0]).toBe(
			"[Watchdog] Session user=user-behind is behind the server (local pts=100, server pts=500) — requesting catch-up",
		);
	});

	it("still handles a confirmed stall when the lookup for the catch-up log line fails", async () => {
		addSession("stalled", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 4);
		addSession("just-fell-behind", 500, 100);
		pendingLookupFailures = 1;
		await tickAfter(watchdog, 1);

		expect(notify).toHaveBeenCalledWith(
			"https://example.com/stalled",
			"telegram_session_disconnected",
			"stalled",
			"user-stalled",
			"disconnected",
			"receiving_updates_stalled",
		);
	});

	it("logs no catch-up line for a session that never falls behind", async () => {
		addSession("quiet", 100, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 10);

		expect(logLinesContaining(warnSpy, "is behind the server")).toHaveLength(0);
	});

	it("disconnects nobody when failed probes hide how many sessions are affected", async () => {
		const fakeSessions = Array.from({ length: 10 }, (_, index) =>
			addSession(`session-${index}`, 500, 100),
		);

		await tickAfter(watchdog, 0);
		for (const fakeSession of fakeSessions.slice(0, 6)) {
			fakeSession.probeError = new Error("authorization probe timed out");
		}
		for (let minute = 0; minute < 5; minute++) await tickAfter(watchdog, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(
			logLinesContaining(warnSpy, "sessions stopped receiving updates"),
		).toHaveLength(1);
	});

	it("logs once that a stalled session has no session record", async () => {
		addSession("orphan", 500, 100);
		sessionRows.length = 0;

		await tickAfter(watchdog, 0);
		for (let minute = 0; minute < 7; minute++) await tickAfter(watchdog, 1);

		expect(
			logLinesContaining(
				warnSpy,
				"[Watchdog] Stalled session has no session record — cannot notify or revoke",
			),
		).toHaveLength(1);
		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("forgets the log limits of a session that left the pool", async () => {
		const session = addSession("stalled", 500, 100);
		notify.mockResolvedValue(false);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);
		sessions.delete("stalled");
		await tickAfter(watchdog, 1);
		sessions.set("stalled", session);
		await tickAfter(watchdog, 1);
		await tickAfter(watchdog, 5);

		expect(
			logLinesContaining(warnSpy, "Disconnect callback not accepted for user=user-stalled"),
		).toHaveLength(2);
	});

	it("sends the callback before logging out", async () => {
		addSession("stalled", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);

		expect(notify.mock.invocationCallOrder[0]).toBeLessThan(
			invalidate.mock.invocationCallOrder[0],
		);
	});

	it("logs the removal of a stalled session without a Telegram error", async () => {
		const logSpy = vi.spyOn(console, "log");
		addSession("stalled", 500, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);

		const removalLines = logLinesContaining(logSpy, "removed reason=");
		expect(removalLines).toHaveLength(1);
		expect(removalLines[0][0]).toBe(
			"[Watchdog] Session id=1 user=user-stalled removed reason=receiving_updates_stalled error=none",
		);
	});

	it("keeps the session when the callback is not accepted", async () => {
		addSession("stalled", 500, 100);
		notify.mockResolvedValue(false);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();

		notify.mockResolvedValue(true);
		await tickAfter(watchdog, 1);

		expect(notify).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledWith("stalled", "receiving_updates_stalled");
	});

	it("does nothing but log when most sessions are behind", async () => {
		addSession("stalled-one", 500, 100);
		addSession("stalled-two", 500, 100);
		addSession("healthy", 100, 100);

		await tickAfter(watchdog, 0);
		await tickAfter(watchdog, 5);
		await tickAfter(watchdog, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(
			logLinesContaining(warnSpy, "2/3 sessions stopped receiving updates"),
		).toHaveLength(1);
	});

	it("limits repeating log lines", async () => {
		addSession("stalled", 500, 100);
		notify.mockResolvedValue(false);

		await tickAfter(watchdog, 0);
		for (let minute = 0; minute < 6; minute++) await tickAfter(watchdog, 1);

		expect(logLinesContaining(warnSpy, "stopped receiving updates")).toHaveLength(1);
		expect(
			logLinesContaining(warnSpy, "Disconnect callback not accepted for user=user-stalled"),
		).toHaveLength(1);
	});

	it("logs when a tick overruns", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(
			watchdog as unknown as { evictLoggedOutSessions: () => Promise<void> },
			"evictLoggedOutSessions",
		).mockReturnValue(new Promise(() => {}));

		void runTick(watchdog);
		await vi.advanceTimersByTimeAsync(6 * MINUTE_MS);
		await runTick(watchdog);
		await vi.advanceTimersByTimeAsync(MINUTE_MS);
		await runTick(watchdog);

		expect(
			logLinesContaining(errorSpy, "[Watchdog] Tick still running after 360s"),
		).toHaveLength(1);
	});
});

describe("TelegramSessionWatchdog existing behaviour", () => {
	let watchdog: TelegramSessionWatchdog;

	beforeEach(() => {
		prepareWatchdogEnvironment();
		watchdog = new TelegramSessionWatchdog();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function runTickThroughCredentialRetries(): Promise<void> {
		const tick = runTick(watchdog);
		await vi.advanceTimersByTimeAsync(20_000);
		await tick;
	}

	function failWithDeadCredentials(session: FakeSession): void {
		session.probeError = Object.assign(new Error("AUTH_KEY_UNREGISTERED"), {
			code: 401,
		});
	}

	function authorizationCheckFailedCallbacks() {
		return notify.mock.calls.filter(([, , , , , reason]) => reason === "authorization_check_failed");
	}

	function spyOnProbes() {
		return vi.spyOn(
			watchdog as unknown as { probeSession: () => Promise<unknown> },
			"probeSession",
		);
	}

	it("does not repeat the credential confirmation while the disconnect callback is not accepted", async () => {
		failWithDeadCredentials(addSession("dead", 100, 100));
		notify.mockResolvedValue(false);
		const probeSession = spyOnProbes();

		await runTickThroughCredentialRetries();
		expect(probeSession).toHaveBeenCalledTimes(3);
		probeSession.mockClear();
		await runTick(watchdog);

		expect(probeSession).toHaveBeenCalledTimes(1);
		expect(authorizationCheckFailedCallbacks()).toHaveLength(2);
		expect(invalidate).not.toHaveBeenCalled();

		notify.mockResolvedValue(true);
		await runTick(watchdog);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("dead", "authorization_check_failed");
	});

	it("confirms the credentials again with retries when a session recovered in between", async () => {
		const session = addSession("dead", 100, 100);
		failWithDeadCredentials(session);
		notify.mockResolvedValue(false);
		const probeSession = spyOnProbes();

		await runTickThroughCredentialRetries();
		session.probeError = undefined;
		await runTick(watchdog);

		expect(authorizationCheckFailedCallbacks()).toHaveLength(1);
		expect(invalidate).not.toHaveBeenCalled();

		failWithDeadCredentials(session);
		probeSession.mockClear();
		await runTickThroughCredentialRetries();

		expect(probeSession).toHaveBeenCalledTimes(3);
		expect(authorizationCheckFailedCallbacks()).toHaveLength(2);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("confirms the credentials again with retries when a probe failed for another reason in between", async () => {
		const session = addSession("dead", 100, 100);
		failWithDeadCredentials(session);
		notify.mockResolvedValue(false);
		const probeSession = spyOnProbes();

		await runTickThroughCredentialRetries();
		session.probeError = new Error("authorization probe timed out");
		await runTick(watchdog);

		expect(authorizationCheckFailedCallbacks()).toHaveLength(1);
		expect(invalidate).not.toHaveBeenCalled();

		failWithDeadCredentials(session);
		probeSession.mockClear();
		await runTickThroughCredentialRetries();

		expect(probeSession).toHaveBeenCalledTimes(3);
		expect(authorizationCheckFailedCallbacks()).toHaveLength(2);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("tells Chat-X a session with dead credentials is disconnected before revoking it", async () => {
		failWithDeadCredentials(addSession("dead", 100, 100));

		await runTickThroughCredentialRetries();

		expect(notify).toHaveBeenCalledWith(
			"https://example.com/dead",
			"telegram_session_disconnected",
			"dead",
			"user-dead",
			"disconnected",
			"authorization_check_failed",
		);
		expect(invalidate).toHaveBeenCalledWith("dead", "authorization_check_failed");
		expect(notify.mock.invocationCallOrder[0]).toBeLessThan(
			invalidate.mock.invocationCallOrder[0],
		);
	});

	it("logs one removal line with the row id, the Telegram user, the reason and the Telegram error, never the session string", async () => {
		const logSpy = vi.spyOn(console, "log");
		const sessionString = "auth-key-session-string";
		failWithDeadCredentials(addSession(sessionString, 100, 100));
		sessionRows[0].telegram_user_id = "777";

		await runTickThroughCredentialRetries();

		const removalLines = logLinesContaining(logSpy, "removed reason=");
		expect(removalLines).toHaveLength(1);
		expect(removalLines[0][0]).toBe(
			"[Watchdog] Session id=1 user=777 removed reason=authorization_check_failed error=AUTH_KEY_UNREGISTERED",
		);
		expect(logLinesContaining(logSpy, sessionString)).toHaveLength(0);
	});

	it("logs no removal line when the session row was already gone", async () => {
		const logSpy = vi.spyOn(console, "log");
		failWithDeadCredentials(addSession("dead", 100, 100));
		invalidate.mockResolvedValue(false);

		await runTickThroughCredentialRetries();

		expect(logLinesContaining(logSpy, "removed reason=")).toHaveLength(0);
	});

	describe("a session missing from the pool", () => {
		beforeEach(() => {
			vi.mocked(TelegramClientService.getPooledSessionIds).mockReturnValue([]);
			vi.mocked(TelegramClientService.isPooled).mockReturnValue(false);
			vi.mocked(TelegramClientService.initialize).mockRejectedValue(
				Object.assign(new Error("AUTH_KEY_UNREGISTERED"), { code: 401 }),
			);
			addSession("missing", 100, 100);
		});

		it("tells Chat-X it is disconnected before revoking it when its credentials are dead", async () => {
			await runTickThroughCredentialRetries();

			expect(notify).toHaveBeenCalledWith(
				"https://example.com/missing",
				"telegram_session_disconnected",
				"missing",
				"user-missing",
				"disconnected",
				"authorization_check_failed",
			);
			expect(invalidate).toHaveBeenCalledWith("missing", "authorization_check_failed");
			const disconnectedCallIndex = notify.mock.calls.findIndex(
				([, , , , , reason]) => reason === "authorization_check_failed",
			);
			expect(notify.mock.invocationCallOrder[disconnectedCallIndex]).toBeLessThan(
				invalidate.mock.invocationCallOrder[0],
			);
		});

		it("keeps it and sends the reconnecting callback once while the disconnect callback is not accepted", async () => {
			notify.mockResolvedValue(false);

			await runTickThroughCredentialRetries();
			await runTickThroughCredentialRetries();

			expect(invalidate).not.toHaveBeenCalled();
			expect(
				notify.mock.calls.filter(([, , , , , reason]) => reason === "reconnecting"),
			).toHaveLength(1);
		});

		it("does not connect again while the disconnect callback is not accepted and logs the first Telegram error when it is removed", async () => {
			const logSpy = vi.spyOn(console, "log");
			notify.mockResolvedValue(false);

			await runTickThroughCredentialRetries();
			expect(TelegramClientService.initialize).toHaveBeenCalledTimes(3);
			vi.mocked(TelegramClientService.initialize).mockClear();
			vi.mocked(TelegramClientService.initialize).mockRejectedValue(
				Object.assign(new Error("SECOND_TICK_ERROR"), { code: 401 }),
			);
			await runTick(watchdog);

			expect(TelegramClientService.initialize).not.toHaveBeenCalled();
			expect(authorizationCheckFailedCallbacks()).toHaveLength(2);
			expect(invalidate).not.toHaveBeenCalled();

			notify.mockResolvedValue(true);
			await runTick(watchdog);

			expect(TelegramClientService.initialize).not.toHaveBeenCalled();
			expect(invalidate).toHaveBeenCalledTimes(1);
			const removalLines = logLinesContaining(logSpy, "removed reason=");
			expect(removalLines).toHaveLength(1);
			expect(removalLines[0][0]).toBe(
				"[Watchdog] Session id=1 user=user-missing removed reason=authorization_check_failed error=AUTH_KEY_UNREGISTERED",
			);
		});
	});

	it("skips eviction when most sessions fail the probe", async () => {
		for (const sessionId of ["one", "two", "three"]) {
			addSession(sessionId, 100, 100).probeError = new Error("network down");
		}

		for (let check = 0; check < 12; check++) await tickAfter(watchdog, 1);

		expect(invalidate).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("reconnects an active session that is missing from the pool", async () => {
		vi.mocked(TelegramClientService.getPooledSessionIds).mockReturnValue([]);
		vi.mocked(TelegramClientService.isPooled).mockReturnValue(false);
		const reconnected = { reconnected: true } as never;
		vi.mocked(TelegramClientService.initialize).mockResolvedValue(reconnected);
		addSession("missing", 100, 100);

		await tickAfter(watchdog, 0);

		expect(TelegramClientService.initialize).toHaveBeenCalledWith("missing");
		expect(TelegramClientService.addToPool).toHaveBeenCalledWith(
			"missing",
			reconnected,
			"user-missing",
		);
	});
});

describe("TelegramSessionWatchdog failed authorization checks", () => {
	let watchdog: TelegramSessionWatchdog;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		prepareWatchdogEnvironment();
		watchdog = new TelegramSessionWatchdog();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function failChecksEvery(intervalSeconds: number, times: number): Promise<void> {
		for (let check = 0; check < times; check++) {
			await vi.advanceTimersByTimeAsync(intervalSeconds * 1000);
			await runTick(watchdog);
		}
	}

	function addFlakySession(sessionId: string): FakeSession {
		const session = addSession(sessionId, 100, 100);
		session.probeError = new Error("authorization probe timed out");
		return session;
	}

	it("sends no callback on a single failed check", async () => {
		addFlakySession("flaky");

		await failChecksEvery(60, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("sends no callback when the checks failed for less than three minutes", async () => {
		addFlakySession("flaky");

		await failChecksEvery(10, 18);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("sends the callback then revokes when the checks failed for three minutes", async () => {
		addFlakySession("flaky");

		await failChecksEvery(10, 19);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"https://example.com/flaky",
			"telegram_session_disconnected",
			"flaky",
			"user-flaky",
			"disconnected",
			"authorization_check_failed",
		);
		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
		expect(notify.mock.invocationCallOrder[0]).toBeLessThan(
			invalidate.mock.invocationCallOrder[0],
		);
	});

	it("waits for three minutes after the first failed check when checks come every minute", async () => {
		addFlakySession("flaky");

		await failChecksEvery(60, 3);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
	});

	it("needs at least three failed checks even when three minutes have passed", async () => {
		addFlakySession("flaky");

		await failChecksEvery(0, 1);
		await failChecksEvery(300, 1);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
	});

	it("restarts the three minutes after a successful check", async () => {
		const session = addFlakySession("flaky");

		await failChecksEvery(60, 3);
		session.probeError = undefined;
		await failChecksEvery(60, 1);
		session.probeError = new Error("authorization probe timed out");
		await failChecksEvery(60, 3);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
	});

	it("keeps the time failed before a tick where most sessions fail and does not count the outage", async () => {
		const flaky = addFlakySession("flaky");
		const others = [addSession("other-one", 100, 100), addSession("other-two", 100, 100)];

		await failChecksEvery(60, 3);
		for (const other of others) other.probeError = new Error("network down");
		await failChecksEvery(60, 5);
		for (const other of others) other.probeError = undefined;
		await failChecksEvery(60, 1);

		expect(flaky.probeError).toBeDefined();
		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
	});

	function setProbeFailing(session: FakeSession, failing: boolean): void {
		session.probeError = failing ? new Error("authorization probe timed out") : undefined;
	}

	it("still revokes a session failing alone when the only healthy session times out now and then", async () => {
		addFlakySession("dead");
		const healthy = addSession("healthy", 100, 100);

		for (let check = 1; check <= 12; check++) {
			setProbeFailing(healthy, check % 3 === 0);
			await failChecksEvery(60, 1);
		}

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("dead", "authorization_check_failed");
	});

	it("still revokes a session failing alone when two of three sessions fail now and then", async () => {
		addFlakySession("dead");
		const healthySessions = [addSession("healthy-one", 100, 100), addSession("healthy-two", 100, 100)];

		for (let check = 1; check <= 12; check++) {
			for (const healthy of healthySessions) setProbeFailing(healthy, check % 3 === 0);
			await failChecksEvery(60, 1);
		}

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("dead", "authorization_check_failed");
	});

	it("does not count a five minute outage and revokes after three minutes of failing alone", async () => {
		addFlakySession("dead");
		const healthy = addSession("healthy", 100, 100);

		setProbeFailing(healthy, true);
		await failChecksEvery(60, 5);
		setProbeFailing(healthy, false);
		await failChecksEvery(60, 3);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("dead", "authorization_check_failed");
	});

	it("adds the time failed alone before and after an outage", async () => {
		addFlakySession("dead");
		const healthy = addSession("healthy", 100, 100);

		await failChecksEvery(10, 16);
		setProbeFailing(healthy, true);
		await failChecksEvery(10, 30);
		setProbeFailing(healthy, false);
		await failChecksEvery(10, 3);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(10, 1);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("dead", "authorization_check_failed");
	});

	it("forgets earlier failures of a session that passes on a tick where most sessions fail", async () => {
		const flaky = addFlakySession("flaky");
		const others = [addSession("other-one", 100, 100), addSession("other-two", 100, 100)];

		await failChecksEvery(60, 3);
		setProbeFailing(flaky, false);
		for (const other of others) setProbeFailing(other, true);
		await failChecksEvery(60, 1);
		setProbeFailing(flaky, true);
		for (const other of others) setProbeFailing(other, false);
		await failChecksEvery(60, 3);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();

		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
	});

	it("logs that all sessions failed at most once per ten minutes during a long outage", async () => {
		addFlakySession("one");
		addFlakySession("two");

		await failChecksEvery(10, 60);

		expect(logLinesContaining(warnSpy, "sessions failed authorization")).toHaveLength(1);

		await failChecksEvery(10, 2);

		expect(logLinesContaining(warnSpy, "sessions failed authorization")).toHaveLength(2);
	});

	it("logs that most sessions failed at most once per ten minutes during a long outage", async () => {
		addFlakySession("one");
		addFlakySession("two");
		addSession("three", 100, 100);

		await failChecksEvery(10, 60);

		expect(logLinesContaining(warnSpy, "sessions failed — likely")).toHaveLength(1);

		await failChecksEvery(10, 2);

		expect(logLinesContaining(warnSpy, "sessions failed — likely")).toHaveLength(2);
	});

	it("revokes directly after three minutes of failed checks when no session row exists", async () => {
		addFlakySession("orphan");
		sessionRows.length = 0;
		const logSpy = vi.spyOn(console, "log");

		await failChecksEvery(60, 4);

		expect(notify).not.toHaveBeenCalled();
		expect(invalidate).toHaveBeenCalledWith("orphan", "authorization_check_failed");
		expect(logLinesContaining(logSpy, "consecutive times — revoked")).toHaveLength(1);
	});

	it("logs the Telegram error of the probe that led to the removal", async () => {
		const logSpy = vi.spyOn(console, "log");
		addFlakySession("flaky");

		await failChecksEvery(10, 19);

		const removalLines = logLinesContaining(logSpy, "removed reason=");
		expect(removalLines).toHaveLength(1);
		expect(removalLines[0][0]).toBe(
			"[Watchdog] Session id=1 user=user-flaky removed reason=authorization_check_failed error=authorization probe timed out",
		);
	});

	it("keeps the session at the threshold when the callback is not accepted", async () => {
		addFlakySession("flaky");
		notify.mockResolvedValue(false);

		await failChecksEvery(60, 5);

		expect(notify).toHaveBeenCalledTimes(2);
		expect(invalidate).not.toHaveBeenCalled();

		notify.mockResolvedValue(true);
		await failChecksEvery(60, 1);

		expect(invalidate).toHaveBeenCalledWith("flaky", "authorization_check_failed");
	});

	it("logs the failed checks at most once per ten minutes", async () => {
		addFlakySession("flaky");
		await failChecksEvery(10, 18);

		const lines = logLinesContaining(warnSpy, "authorization check failed");
		expect(lines).toHaveLength(1);
		expect(lines[0][0]).toBe(
			"[Watchdog] Session authorization check failed (failed checks: 1, failing for 0s)",
		);
	});
});
