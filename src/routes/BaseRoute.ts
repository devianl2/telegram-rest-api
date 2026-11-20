import { FastifyInstance } from "fastify";
import { TelegramClientService } from "../telegram/TelegramClientService";

export abstract class BaseRoute {
	abstract register(fastify: FastifyInstance): Promise<void>;
	/**
	 * Resolves a Telegram client for the given session and executes the
	 * operation. Temporary (non-pooled) clients are destroyed after use.
	 * A session Telegram rejects is not removed here: the watchdog tells
	 * Chat-X it is disconnected and then removes it.
	 * Caution: Use this method for authorized sessions only (E.g send message, get user info, logout, etc.).
	 */
	protected async withTelegramSession<T>(
		sessionId: string,
		operation: (client: TelegramClientService) => Promise<T>,
	): Promise<T> {
		if (!TelegramClientService.isPooled(sessionId)) {
			const sessionRecord = await TelegramClientService.findSessionRecord(sessionId).catch(
				(error: unknown) => {
					console.error(
						`[BaseRoute] Session lookup failed: ${error instanceof Error && error.cause instanceof Error ? error.cause.message : "database error"}`,
					);
					throw Object.assign(new Error("Session lookup failed. Please try again."), {
						code: 503,
					});
				},
			);
			if (!sessionRecord) {
				throw Object.assign(
					new Error("Session not found on this server. Please reconnect the channel."),
					{ code: 401 },
				);
			}
		}
		const isPooled = TelegramClientService.isPooled(sessionId);
		const client = await TelegramClientService.initialize(sessionId);
		try {
			return await operation(client);
		} finally {
			if (!isPooled) await client.destroy();
		}
	}
}
