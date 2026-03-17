import { Api, TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Prisma } from "@prisma/client";
import { DatabaseClient } from "../database/DatabaseClient";
import { AlbumBuffer } from "./AlbumBuffer";
import { ParsedMedia } from "./interface/MessagePipeline";

const ALBUM_BUFFER_MS = parseInt(process.env.ALBUM_BUFFER_MS ?? "300", 10);

export class IncomingMessageHandler {
	private static readonly INIT_DELAY_MS = 5000;

	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private readonly sessionId: string;
	private handler: ((event: NewMessageEvent) => Promise<void>) | null = null;
	private albumBuffer: AlbumBuffer;

	constructor(
		client: TelegramClient,
		telegramUserId: string,
		sessionId: string,
	) {
		this.client = client;
		this.telegramUserId = telegramUserId;
		this.sessionId = sessionId;
		this.albumBuffer = new AlbumBuffer(ALBUM_BUFFER_MS, (messages) =>
			this.handleBatch(messages),
		);
	}

	async start(): Promise<void> {
		this.handler = async (event: NewMessageEvent) => {
			try {
				this.albumBuffer.push(event.message);
			} catch (error) {
				console.error(
					`[MessageHandler] Error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(
			this.handler,
			new NewMessage({
				incoming: true,
			}),
		);

		// Wait for the connection to fully establish before fetching dialogs.
		await this.delay(IncomingMessageHandler.INIT_DELAY_MS);

		try {
			const dialogs = await this.client.getDialogs({});

			// Force gramjs to fully initialise its per-channel pts by
			// fetching a recent message from every channel / supergroup.
			// Without this, megagroups with large pts gaps silently
			// drop UpdateNewChannelMessage because gramjs cannot
			// validate the sequence.
			let synced = 0;
			for (const dialog of dialogs) {
				if (dialog.isChannel) {
					try {
						await this.client.getMessages(dialog.inputEntity, {
							limit: 1,
						});
						synced++;
					} catch {
						// Channel might be restricted or deleted — skip
					}
				}
			}
			console.log(
				`[MessageHandler] Synced ${synced} channel(s) for user ${this.telegramUserId}`,
			);
		} catch (error) {
			console.error(
				`[MessageHandler] Dialog sync error for user ${this.telegramUserId}:`,
				error,
			);
		}

		console.log(`[MessageHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(
				this.handler,
				new NewMessage({ incoming: true }),
			);
			this.handler = null;
		}
	}

	private async handleBatch(messages: Api.Message[]): Promise<void> {
		const firstMsg = messages[0];
		const chatId = this.extractPeerId(firstMsg.peerId) ?? "";
		const messageText = messages
			.map((m) => m.text ?? "")
			.filter(Boolean)
			.join("\n");

		const mediaList: ParsedMedia[] = [];
		for (const msg of messages) {
			const parsed = this.extractMedia(msg);
			if (parsed) mediaList.push(parsed);
		}

		const tenantId = await this.resolveTenantId();
		if (tenantId === null) {
			console.error(
				`[MessageHandler] No tenant found for session ${this.sessionId}`,
			);
			return;
		}

		const hasAttachments = mediaList.length > 0;

		// from_account = actual sender; fall back to chatId for channel posts (no fromId)
		const fromAccount = this.extractPeerId(firstMsg.fromId) ?? chatId;
		const rawPayload = this.serializeMessages(messages);

		const db = DatabaseClient.getInstance();
		await db.execute(async (prisma) => {
			return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
				const msgRecord = await tx.message.create({
					data: {
						tenant_id: tenantId,
						telegram_chat_id: chatId,
						telegram_message_id: firstMsg.id,
					from_account: fromAccount,
					to_account: this.telegramUserId,
					message: messageText || null,
					raw_payload: rawPayload,
					received_timestamp: firstMsg.date ?? null,
					status: hasAttachments ? "pending" : "downloaded",
					},
				});

				const resolvedUrls: (string | null)[] = [];

				for (const media of mediaList) {
					const existingTask = await tx.downloadTask.findUnique({
						where: { file_unique_id: media.fileUniqueId },
					});

					let fileUrl: string | null = null;

					if (existingTask?.status === "completed") {
						fileUrl = existingTask.file_url;
					} else if (!existingTask) {
						await tx.downloadTask.create({
							data: {
								file_unique_id: media.fileUniqueId,
								file_type: media.fileType,
								raw_input_json: media.rawInputJson,
								from_accounts: [this.sessionId],
								status: "pending",
							},
						});
					} else {
						if (!existingTask.from_accounts.includes(this.sessionId)) {
							await tx.downloadTask.update({
								where: { file_unique_id: media.fileUniqueId },
								data: {
									from_accounts: {
										push: this.sessionId,
									},
								},
							});
						}
					}

					await tx.attachment.create({
						data: {
							message_id: msgRecord.id,
							file_unique_id: media.fileUniqueId,
							file_type: media.fileType,
							file_url: fileUrl,
						},
					});

					resolvedUrls.push(fileUrl);
				}

				const allResolved =
					hasAttachments && resolvedUrls.every((u) => u !== null);
				if (allResolved) {
					await tx.message.update({
						where: { id: msgRecord.id },
						data: { status: "downloaded" },
					});
				}
			});
		});
	}

	private extractMedia(msg: Api.Message): ParsedMedia | null {
		const media = msg.media;
		if (!media) return null;

		if (media instanceof Api.MessageMediaPhoto && media.photo) {
			const photo = media.photo as Api.Photo;
			const bestSize = photo.sizes[photo.sizes.length - 1];
			const thumbType =
				"type" in bestSize ? (bestSize as Api.PhotoSize).type : "x";
			return {
				fileUniqueId: `photo_${photo.id.toString()}`,
				fileType: "photo",
				rawInputJson: JSON.stringify({
					type: "photo",
					id: photo.id.toString(),
					accessHash: photo.accessHash.toString(),
					fileReference: Buffer.from(photo.fileReference).toString("base64"),
					thumbSize: thumbType,
					dcId: photo.dcId,
				}),
			};
		}

		if (media instanceof Api.MessageMediaDocument && media.document) {
			const doc = media.document as Api.Document;
			const isVideo = doc.mimeType?.startsWith("video/");
			const isAudio = doc.mimeType?.startsWith("audio/");
			let fileType = "document";
			if (isVideo) fileType = "video";
			else if (isAudio) fileType = "audio";

			return {
				fileUniqueId: `doc_${doc.id.toString()}`,
				fileType,
				rawInputJson: JSON.stringify({
					type: "document",
					id: doc.id.toString(),
					accessHash: doc.accessHash.toString(),
					fileReference: Buffer.from(doc.fileReference).toString("base64"),
					thumbSize: "",
					dcId: doc.dcId,
					mimeType: doc.mimeType,
					fileName: this.extractFileName(doc),
				}),
			};
		}

		return null;
	}

	private extractFileName(doc: Api.Document): string {
		for (const attr of doc.attributes) {
			if (attr instanceof Api.DocumentAttributeFilename) {
				return attr.fileName;
			}
		}
		const ext =
			(doc.mimeType ?? "application/octet-stream").split("/")[1] ?? "bin";
		return `${doc.id}.${ext}`;
	}

	private extractPeerId(peer: Api.TypePeer | null | undefined): string | null {
		if (!peer) return null;
		if (peer instanceof Api.PeerUser) return peer.userId.toString();
		if (peer instanceof Api.PeerChat) return peer.chatId.toString();
		if (peer instanceof Api.PeerChannel) return peer.channelId.toString();
		return null;
	}

	private serializeMessages(messages: Api.Message[]): string {
		return JSON.stringify(messages, (_, value) =>
			typeof value === "bigint" ? value.toString() : value,
		);
	}

	private async resolveTenantId(): Promise<number | null> {
		const db = DatabaseClient.getInstance();
		const session = await db.execute(
			(prisma) =>
				prisma.telegramSession.findFirst({
					where: {
						telegram_user_id: this.telegramUserId,
						status: "active",
					},
					select: { tenant_id: true },
				}) as Promise<{ tenant_id: number } | null>,
		);
		return session?.tenant_id ?? null;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
