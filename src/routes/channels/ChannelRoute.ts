import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";

export class ChannelRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches supergroups and channels by their numeric ID and accessHash.
		 * Both values are available in the chats[] array of the GetDialogs response
		 * for all channels — public and private alike.
		 *
		 * For basic groups (className === "Chat") use /chats/GetChats instead.
		 */
		fastify.post(
			"/channels/GetChannels",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, channels } = request.body as {
					sessionId: string;
					channels: { id: string; accessHash: string }[];
				};

				if (!sessionId || !channels?.length) {
					return new ErrorResponse(
						"sessionId and channels are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.channels.GetChannels({
								id: channels.map(
									(c) =>
										new Api.InputChannel({
											channelId: BigInt(c.id),
											accessHash: BigInt(c.accessHash),
										}),
								),
							}),
						),
					);

					new SuccessResponse([result], "Channels fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
