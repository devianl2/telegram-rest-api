const SERVER_NAME = process.env.SERVER_NAME ?? "";

const FAILURE_LOG_INTERVAL_MS = 10 * 60_000;

const CALLBACK_TIMEOUT_MS = parseInt(
	process.env.CALLBACK_TIMEOUT_MS ?? "4000",
	10,
);

export type SessionLifecycleEvent =
	| "telegram_session_removed"
	| "telegram_session_disconnected";

export type SessionLifecycleStatus =
	| "removed"
	| "disconnected"
	| "reconnecting";

export type SessionLifecycleReason =
	| "logout"
	| "unauthorized"
	| "authorization_check_failed"
	| "reconnecting"
	| "reconnect_failed"
	| "receiving_updates_stalled";

interface SessionLifecyclePayload {
	event: SessionLifecycleEvent;
	sessionId: string;
	telegramUserId: string;
	status: SessionLifecycleStatus;
	reason: SessionLifecycleReason;
	serverName: string;
	timestamp: string;
}

export class SessionCallbackService {
	private static readonly lastFailureLoggedAt = new Map<string, number>();

	static async notify(
		callbackUrl: string,
		event: SessionLifecycleEvent,
		sessionId: string,
		telegramUserId: string,
		status: SessionLifecycleStatus,
		reason: SessionLifecycleReason,
	): Promise<boolean> {
		const payload: SessionLifecyclePayload = {
			event,
			sessionId,
			telegramUserId,
			status,
			reason,
			serverName: SERVER_NAME,
			timestamp: new Date().toISOString(),
		};

		try {
			const res = await fetch(callbackUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
			});

			if (!res.ok) {
				SessionCallbackService.logFailure(
					event,
					telegramUserId,
					`[SessionCallback] POST to ${callbackUrl} returned HTTP ${res.status} ${res.statusText}`,
				);
			}

			return res.ok;
		} catch (error) {
			SessionCallbackService.logFailure(
				event,
				telegramUserId,
				`[SessionCallback] POST to ${callbackUrl} failed:`,
				error instanceof Error ? error.message : error,
			);
			return false;
		}
	}

	private static logFailure(
		event: SessionLifecycleEvent,
		telegramUserId: string,
		...message: unknown[]
	): void {
		const key = `${event}:${telegramUserId}`;
		const now = Date.now();
		const lastLoggedAt = SessionCallbackService.lastFailureLoggedAt.get(key);
		if (lastLoggedAt !== undefined && now - lastLoggedAt < FAILURE_LOG_INTERVAL_MS) {
			return;
		}

		SessionCallbackService.lastFailureLoggedAt.set(key, now);
		console.error(...message);
	}
}
