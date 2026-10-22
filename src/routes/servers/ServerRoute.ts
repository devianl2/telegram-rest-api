import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, and, count } from "drizzle-orm";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { DatabaseClient } from "../../database/DatabaseClient";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { SessionStatus } from "../../database/constants/SessionStatus";
import { ServerAuthMiddleware } from "../../http/middleware/ServerAuthMiddleware";
import { telegramSessions } from "../../database/schema";

export class ServerRoute extends BaseRoute {
	/** Sends the 500 and returns undefined when SERVER_NAME is unset. */
	private serverNameOr500(reply: FastifyReply): string | undefined {
		const serverName = process.env.SERVER_NAME ?? "";
		if (!serverName) {
			new ErrorResponse(
				"SERVER_NAME is not configured on this server",
				500,
			).send(reply);
			return undefined;
		}
		return serverName;
	}

	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Returns HTTP 200 with a simple OK payload.
		 * Intentionally kept outside the protected scope — no api-key required
		 * so that load balancer health probes never need credentials.
		 */
		fastify.get(
			"/health",
			async (_request: FastifyRequest, reply: FastifyReply) => {
				new SuccessResponse({ status: "ok" }, "Server is healthy").send(reply);
			},
		);

		/**
		 * Protected scope — all routes registered inside here require a valid
		 * `api-key` header matching the APPLICATION_API_KEY environment variable.
		 */
		fastify.register(async (protected_: FastifyInstance) => {
			protected_.addHook("onRequest", new ServerAuthMiddleware().handle);

			/**
			 * Returns server-wide runtime statistics.
			 */
			protected_.get(
				"/server/GetStatistics",
				async (_request: FastifyRequest, reply: FastifyReply) => {
					const serverName = this.serverNameOr500(reply);
					if (!serverName) return;

					try {
						const db = DatabaseClient.getInstance();

						const [row] = await db.execute((d) =>
							d
								.select({ count: count() })
								.from(telegramSessions)
								.where(
									and(
										eq(telegramSessions.status, SessionStatus.ACTIVE),
										eq(telegramSessions.server_name, serverName),
									),
								),
						);
						const activeSessions = row?.count ?? 0;

						new SuccessResponse(
							{
								poolSize: TelegramClientService.getPooledSessionIds().length,
								activeSessions,
							},
							"Statistics retrieved successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);

			/**
			 * Reports whether a session is live on this server: `pooled` is the
			 * in-memory client pool, `status` comes from this server's own
			 * `telegram_sessions` row and is null when no such row exists.
			 * Must stay read-only: never calls Telegram.
			 */
			protected_.post(
				"/server/GetSessionStatus",
				async (request: FastifyRequest, reply: FastifyReply) => {
					const { sessionId } = request.body as { sessionId?: string };

					if (!sessionId) {
						return new ErrorResponse("sessionId is required", 400).send(reply);
					}

					const serverName = this.serverNameOr500(reply);
					if (!serverName) return;

					try {
						const db = DatabaseClient.getInstance();

						const [row] = await db.execute((d) =>
							d
								.select({ status: telegramSessions.status })
								.from(telegramSessions)
								.where(
									and(
										eq(telegramSessions.session_id, sessionId),
										eq(telegramSessions.server_name, serverName),
									),
								)
								.limit(1),
						);

						new SuccessResponse(
							{
								sessionId,
								pooled: TelegramClientService.isPooled(sessionId),
								status: row?.status ?? null,
								serverName,
							},
							"Session status retrieved successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);

			/**
			 * Lists every session row owned by this server, each flagged with
			 * whether its client is currently held in the pool.
			 * Must stay read-only: never calls Telegram.
			 */
			protected_.post(
				"/server/GetSessions",
				async (_request: FastifyRequest, reply: FastifyReply) => {
					const serverName = this.serverNameOr500(reply);
					if (!serverName) return;

					try {
						const db = DatabaseClient.getInstance();

						const rows = await db.execute((d) =>
							d
								.select({
									sessionId: telegramSessions.session_id,
									telegramUserId: telegramSessions.telegram_user_id,
									telegramUsername: telegramSessions.telegram_username,
									status: telegramSessions.status,
									updatedAt: telegramSessions.updated_at,
								})
								.from(telegramSessions)
								.where(eq(telegramSessions.server_name, serverName)),
						);

						new SuccessResponse(
							rows.map((row) => ({
								...row,
								pooled: TelegramClientService.isPooled(row.sessionId),
							})),
							"Sessions retrieved successfully",
						).send(reply);
					} catch (error: unknown) {
						ErrorResponse.fromError(error, 500).send(reply);
					}
				},
			);
		}); // end protected scope
	}
}
