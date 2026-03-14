import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramUtils } from "../../telegram/TelegramUtils";

export class ChatRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches all chats except the ones with the specified IDs.
		 */
		fastify.post(
			"/chats/GetAllChats",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, exceptIds } = request.body as {
					sessionId: string;
					exceptIds: string[];
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId required", 400).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.GetAllChats({
								exceptIds: exceptIds.map(BigInt),
							}),
						),
					);

					new SuccessResponse([result], "All chats fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Fetches chats by their IDs.
		 */
		fastify.post(
			"/chats/GetChats",
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
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.GetChats({
								id: id.map(BigInt),
							}),
						),
					);

					new SuccessResponse([result], "Chats fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Fetches chats by their IDs.
		 */
		fastify.post(
			"/chats/GetFullChat",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId } = request.body as {
					sessionId: string;
					chatId: string;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.GetFullChat({
								chatId: BigInt(chatId),
							}),
						),
					);

					new SuccessResponse([result], "Full chat fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Creates a new group chat and invites the specified users.
		 */
		fastify.post(
			"/chats/CreateChat",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, users, title } = request.body as {
					sessionId: string;
					users: string[];
					title: string;
				};

				if (!sessionId || !users?.length || !title) {
					return new ErrorResponse(
						"sessionId, users and title are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.CreateChat({ users, title })),
					);

					new SuccessResponse([result], "Chat created successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes a chat, or removes a specific user from a chat.
		 * Pass `userId` to remove only that user; omit it to delete the chat entirely.
		 */
		fastify.post(
			"/chats/DeleteChat",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, userId, revokeHistory } = request.body as {
					sessionId: string;
					chatId: string;
					userId?: string;
					revokeHistory?: boolean;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.DeleteChat({
								chatId: BigInt(chatId),
								userId: userId,
								revokeHistory: revokeHistory,
							}),
						),
					);

					new SuccessResponse([result], "Chat deleted successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes a chat, or removes a specific user from a chat.
		 * Pass `userId` to remove only that user; omit it to delete the chat entirely.
		 */
		fastify.post(
			"/chats/DeleteChatUser",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, userId, revokeHistory } = request.body as {
					sessionId: string;
					chatId: string;
					userId?: string;
					revokeHistory?: boolean;
				};

				if (!sessionId || !chatId || !userId) {
					return new ErrorResponse(
						"sessionId, chatId and userId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.DeleteChatUser({
								chatId: BigInt(chatId),
								userId: userId,
								revokeHistory: revokeHistory,
							}),
						),
					);

					new SuccessResponse(
						[result],
						"User deleted from chat successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Grants or revokes admin rights for a user in a basic group chat.
		 */
		fastify.post(
			"/chats/EditChatAdmin",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, userId, isAdmin } = request.body as {
					sessionId: string;
					chatId: string;
					userId: string;
					isAdmin: boolean;
				};

				if (!sessionId || !chatId || !userId || isAdmin === undefined) {
					return new ErrorResponse(
						"sessionId, chatId, userId and isAdmin are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.EditChatAdmin({
								chatId: BigInt(chatId),
								userId,
								isAdmin,
							}),
						),
					);

					new SuccessResponse(
						[result],
						"Chat admin rights updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Updates the default banned rights for all members of a chat or channel.
		 * All `bannedRights` flags are optional and default to false (no restriction).
		 */
		fastify.post(
			"/chats/EditChatDefaultBannedRights",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					bannedRights: {
						untilDate = 0,
						viewMessages = false,
						sendMessages = false,
						sendMedia = false,
						sendStickers = false,
						sendGifs = false,
						sendGames = false,
						sendInline = false,
						sendPolls = false,
						changeInfo = false,
						inviteUsers = false,
						pinMessages = false,
					} = {},
				} = request.body as {
					sessionId: string;
					peer: string;
					bannedRights?: {
						untilDate?: number;
						viewMessages?: boolean;
						sendMessages?: boolean;
						sendMedia?: boolean;
						sendStickers?: boolean;
						sendGifs?: boolean;
						sendGames?: boolean;
						sendInline?: boolean;
						sendPolls?: boolean;
						changeInfo?: boolean;
						inviteUsers?: boolean;
						pinMessages?: boolean;
					};
				};

				if (!sessionId || !peer) {
					return new ErrorResponse("sessionId and peer are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.EditChatDefaultBannedRights({
								peer,
								bannedRights: new Api.ChatBannedRights({
									untilDate,
									viewMessages,
									sendMessages,
									sendMedia,
									sendStickers,
									sendGifs,
									sendGames,
									sendInline,
									sendPolls,
									changeInfo,
									inviteUsers,
									pinMessages,
								}),
							}),
						),
					);

					new SuccessResponse(
						[result],
						"Default banned rights updated successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Changes the photo of a group chat.
		 * Provide `photoUrl` to set a new photo; omit it to remove the current photo.
		 */
		fastify.post(
			"/chats/EditChatPhoto",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, photoUrl } = request.body as {
					sessionId: string;
					chatId: string;
					photoUrl?: string;
				};

				if (!sessionId || !chatId) {
					return new ErrorResponse(
						"sessionId and chatId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tc = client.getClient();

							let photo: Api.TypeInputChatPhoto;
							if (photoUrl) {
								const { buffer, filename } =
									await TelegramUtils.downloadFromUrl(photoUrl);
								const uploadedFile = await tc.uploadFile({
									file: new CustomFile(filename, buffer.length, "", buffer),
									workers: 1,
								});
								photo = new Api.InputChatUploadedPhoto({ file: uploadedFile });
							} else {
								photo = new Api.InputChatPhotoEmpty();
							}

							return tc.invoke(
								new Api.messages.EditChatPhoto({
									chatId: BigInt(chatId),
									photo,
								}),
							);
						},
					);

					new SuccessResponse([result], "Chat photo updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Changes the title of a group chat.
		 */
		fastify.post(
			"/chats/EditChatTitle",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, chatId, title } = request.body as {
					sessionId: string;
					chatId: string;
					title: string;
				};

				if (!sessionId || !chatId || !title) {
					return new ErrorResponse(
						"sessionId, chatId and title are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.EditChatTitle({
								chatId: BigInt(chatId),
								title,
							}),
						),
					);

					new SuccessResponse([result], "Chat title updated successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
