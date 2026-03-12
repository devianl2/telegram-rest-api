import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { TelegramUtils } from "../../telegram/TelegramUtils";

/**
 * All routes require a valid session code.
 * The session code identifies the user and authorises the operation.
 */
export class UserRoute extends BaseRoute {
	/**
	 * Executes the operation with a Telegram client for the given session.
	 * Temporary (non-pooled) clients are destroyed after use;
	 * unauthorised sessions are invalidated automatically.
	 */
	private async telegramSession<T>(
		sessionId: string,
		operation: (client: TelegramClientService) => Promise<T>,
	): Promise<T> {
		const isPooled = TelegramClientService.isPooled(sessionId);
		const client = await TelegramClientService.initialize(sessionId);
		try {
			return await operation(client);
		} catch (error: unknown) {
			if (TelegramUtils.isUnauthorized(error)) {
				await TelegramClientService.invalidate(sessionId);
			}
			throw error;
		} finally {
			if (!isPooled) await client.destroy();
		}
	}

	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches a full user by their ID.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/users/GetFullUser",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string;
				};

				if (!sessionId || !id) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.telegramSession(sessionId, (client) =>
						client.getClient().invoke(new Api.users.GetFullUser({ id })),
					);

					new SuccessResponse([result], "User fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns basic user info according to their identifiers ids or usernames.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/users/GetUsers",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string[];
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.telegramSession(sessionId, (client) =>
						client.getClient().invoke(new Api.users.GetUsers({ id })),
					);

					new SuccessResponse(result, "Users fetched successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
