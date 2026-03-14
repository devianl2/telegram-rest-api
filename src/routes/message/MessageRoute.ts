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
					photos = [],
					videos = [],
					files = [],
				} = request.body as {
					sessionId: string;
					peer: string;
					message?: string;
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
										randomId: TelegramUtils.randomId(),
										message: index === 0 ? message : "",
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
	}
}
