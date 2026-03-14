import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramUtils, MediaType } from "../../telegram/TelegramUtils";

interface MediaEntry {
	url: string;
	type: MediaType;
}

export class MessageRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Sends a message to a peer with optional media attachments.
		 *
		 * - No attachments         → messages.SendMessage
		 * - Single attachment      → messages.SendMedia
		 * - Multiple attachments   → messages.SendMultiMedia (album; caption on first item)
		 *
		 * Each URL is downloaded server-side and uploaded to Telegram before sending.
		 */
		fastify.post(
			"/messages/SendMessage",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					message = "",
					replyToMessageId = 0,
					silent = false,
					background = false,
					scheduleDate = 0,
					photos = [],
					videos = [],
					files = [],
				} = request.body as {
					sessionId: string;
					peer: string;
					message?: string;
					replyToMessageId?: number;
					silent?: boolean;
					background?: boolean;
					scheduleDate?: number;
					photos?: string[];
					videos?: string[];
					files?: string[];
				};

				if (!sessionId || !peer) {
					return new ErrorResponse("sessionId and peer are required", 400).send(
						reply,
					);
				}

				const allMedia: MediaEntry[] = [
					...photos.map((url) => ({ url, type: "photo" as const })),
					...videos.map((url) => ({ url, type: "video" as const })),
					...files.map((url) => ({ url, type: "file" as const })),
				];

				try {
					const result = await this.withTelegramSession(
						sessionId,
						async (clientService) => {
							const tc = clientService.getClient();

							if (allMedia.length === 0) {
								return tc.invoke(
									new Api.messages.SendMessage({
										peer,
										message,
										silent,
										background,
										...(scheduleDate && { scheduleDate: scheduleDate }),
										...(replyToMessageId && { replyToMsgId: replyToMessageId }),
										randomId: TelegramUtils.randomId(),
									}),
								);
							}

							if (allMedia.length === 1) {
								const media = await TelegramUtils.uploadMedia(
									tc,
									allMedia[0].url,
									allMedia[0].type,
								);
								return tc.invoke(
									new Api.messages.SendMedia({
										peer,
										media,
										message,
										silent,
										background,
										...(scheduleDate && { scheduleDate: scheduleDate }),
										...(replyToMessageId && { replyToMsgId: replyToMessageId }),
										randomId: TelegramUtils.randomId(),
									}),
								);
							}

							// Album: upload all files in parallel, caption on first item only
							const uploadedMedia = await Promise.all(
								allMedia.map(({ url, type }) =>
									TelegramUtils.uploadMedia(tc, url, type),
								),
							);

							const multiMedia = uploadedMedia.map(
								(media: Api.TypeInputMedia, index: number) =>
									new Api.InputSingleMedia({
										media,
										silent,
										background,
										randomId: TelegramUtils.randomId(),
										message: index === 0 ? message : "",
										...(scheduleDate && { scheduleDate: scheduleDate }),
										...(replyToMessageId && { replyToMsgId: replyToMessageId }),
									}),
							);

							return tc.invoke(
								new Api.messages.SendMultiMedia({ peer, multiMedia }),
							);
						},
					);

					new SuccessResponse([result], "Message sent successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
		/**
		 * Reacts to a message with a UTF-8 emoji.
		 * Omit `reaction` to remove an existing reaction.
		 */
		fastify.post(
			"/messages/SendReaction",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					msgId,
					reaction,
					big = false,
				} = request.body as {
					sessionId: string;
					peer: string;
					msgId: number;
					reaction?: string;
					big?: boolean;
				};

				if (!sessionId || !peer || !msgId) {
					return new ErrorResponse(
						"sessionId, peer and msgId are required",
						400,
					).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(
							new Api.messages.SendReaction({
								peer,
								msgId,
								big,
								...(reaction && { reaction }),
							}),
						),
					);

					new SuccessResponse([result], "Reaction sent successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
		/**
		 * Marks messages in a chat as read up to (and including) the given message ID.
		 * Pass maxId: 0 to mark the entire history as read.
		 */
		fastify.post(
			"/messages/ReadHistory",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					peer,
					maxId = 0,
				} = request.body as {
					sessionId: string;
					peer: string;
					maxId?: number;
				};

				if (!sessionId || !peer) {
					return new ErrorResponse("sessionId and peer are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.ReadHistory({ peer, maxId })),
					);

					new SuccessResponse([result], "History marked as read").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		fastify.post(
			"/messages/ReceivedMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, maxId = 0 } = request.body as {
					sessionId: string;
					maxId?: number;
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.ReceivedMessages({ maxId })),
					);

					new SuccessResponse(
						[result],
						"Received messages fetched successfully",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Deletes messages by ID.
		 * `revoke: true`  — deletes for everyone.
		 * `revoke: false` — deletes only for the current user (default).
		 *
		 * Note: this method works for private chats and basic groups.
		 * For supergroups/channels use channels.DeleteMessages instead.
		 */
		fastify.post(
			"/messages/DeleteMessages",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const {
					sessionId,
					id,
					revoke = false,
				} = request.body as {
					sessionId: string;
					id: number[];
					revoke?: boolean;
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client
							.getClient()
							.invoke(new Api.messages.DeleteMessages({ id, revoke })),
					);

					new SuccessResponse([result], "Messages deleted successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
