import { TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api } from "telegram";
import * as fs from "fs";
import * as path from "path";

interface MediaInfo {
	type: string;
	id?: string;
	accessHash?: string;
	fileSize?: number;
	mimeType?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
}

interface MessageLogEntry {
	timestamp: string;
	messageId: number;
	chatId: string;
	senderId: string;
	senderUsername?: string;
	isPrivate: boolean;
	isGroup: boolean;
	isChannel: boolean;
	text: string;
	date: number;
	replyToMessageId?: number;
	forwardFromId?: string;
	media?: MediaInfo;
}

/**
 * Attaches an incoming-message event listener to a TelegramClient.
 * Messages are NOT marked as read. Each message is appended as a JSON line
 * to storage/<telegramUserId>.log.
 */
export class IncomingMessageHandler {
	private static readonly STORAGE_DIR = path.resolve(
		process.cwd(),
		"storage",
	);

	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((event: NewMessageEvent) => Promise<void>) | null = null;

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
		IncomingMessageHandler.ensureStorageDir();
	}

	private static ensureStorageDir(): void {
		if (!fs.existsSync(IncomingMessageHandler.STORAGE_DIR)) {
			fs.mkdirSync(IncomingMessageHandler.STORAGE_DIR, { recursive: true });
		}
	}

	private static extractMedia(
		media: Api.TypeMessageMedia | null | undefined,
	): MediaInfo | undefined {
		if (!media) return undefined;

		if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
			return {
				type: "photo",
				id: media.photo.id.toString(),
				accessHash: media.photo.accessHash.toString(),
				fileSize: media.photo.sizes?.length ?? 0,
			};
		}

		if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
			const doc = media.document;
			const fileNameAttr = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeFilename,
			) as Api.DocumentAttributeFilename | undefined;
			const videoAttr = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeVideo,
			) as Api.DocumentAttributeVideo | undefined;
			const audioAttr = doc.attributes?.find(
				(a) => a instanceof Api.DocumentAttributeAudio,
			) as Api.DocumentAttributeAudio | undefined;

			return {
				type: videoAttr ? "video" : audioAttr ? "audio" : "document",
				id: doc.id.toString(),
				accessHash: doc.accessHash.toString(),
				fileSize: Number(doc.size),
				mimeType: doc.mimeType,
				fileName: fileNameAttr?.fileName,
				duration: videoAttr?.duration ?? audioAttr?.duration,
				width: videoAttr?.w,
				height: videoAttr?.h,
			};
		}

		if (media instanceof Api.MessageMediaGeo && media.geo instanceof Api.GeoPoint) {
			return {
				type: "geo",
			};
		}

		if (media instanceof Api.MessageMediaContact) {
			return {
				type: "contact",
			};
		}

		return { type: media.className ?? "unknown" };
	}

	async start(): Promise<void> {
		this.handler = async (event: NewMessageEvent) => {
			try {
				const message = event.message;

				const entry: MessageLogEntry = {
					timestamp: new Date().toISOString(),
					messageId: message.id,
					chatId: message.chatId?.toString() ?? "",
					senderId: message.senderId?.toString() ?? "",
					isPrivate: event.isPrivate ?? false,
					isGroup: event.isGroup ?? false,
					isChannel: event.isChannel ?? false,
					text: message.text ?? "",
					date: message.date,
					replyToMessageId: message.replyTo?.replyToMsgId,
					forwardFromId: message.fwdFrom?.fromId?.toString(),
					media: IncomingMessageHandler.extractMedia(message.media),
				};

				const logPath = path.join(
					IncomingMessageHandler.STORAGE_DIR,
					`${this.telegramUserId}.log`,
				);
				fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
			} catch (error) {
				console.error(
					`Message handler error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		// Register handler BEFORE catch-up so no messages are missed
		this.client.addEventHandler(this.handler, new NewMessage({ incoming: true }));

		// GramJS needs an initial getDialogs() call to populate the update state (pts/date).
		// Without this, the update loop has no baseline and events never fire.
		try {
			await this.client.getDialogs({ limit: 1 });
		} catch {
			// Non-fatal — events may still work if the session already has update state
		}

		console.log(`Message handler started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(this.handler, new NewMessage({ incoming: true }));
			this.handler = null;
		}
	}
}
