import { Api, TelegramClient } from "telegram";
import { Raw } from "telegram/events";

/**
 * Temporary debug handler — logs every raw MTProto update to the console
 * with its className and serialized payload for manual inspection.
 *
 * Remove this handler once all event payloads have been documented.
 */
export class IncomingRawDebugHandler {
	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((update: Api.TypeUpdate) => void) | null = null;

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
	}

	start(): void {
		this.handler = (update: Api.TypeUpdate) => {
			const className =
				(update as { className?: string }).className ?? update.constructor.name;

			if (className === "UpdateConnectionState") return;
			if (className === "UpdateUserStatus") return;
			if (className === "UpdateReadHistoryInbox") return;
			if (className === "UpdateReadHistoryOutbox") return;
			if (className === "UpdateReadChannelInbox") return;
			if (className === "UpdateReadChannelOutbox") return;
			if (className === "UpdateReadMessagesContents") return;
			if (className === "UpdateNewMessage") return;
			if (className === "UpdateNewChannelMessage") return;
			if (className === "UpdateShortChatMessage") return;
			if (className === "UpdateEditMessage") return;
			if (className === "UpdateDeleteMessages") return;
			if (className === "UpdateEditChannelMessage") return;
			if (className === "UpdateDeleteChannelMessages") return;
			if (className === "UpdateReadChannelDiscussionInbox") return;

			if (className === "UpdateChat") {
				this.client.getEntity(update.chatId).then((chat: Api.Chat) => {
					console.log(chat);
				});
			}

			try {
				const seen = new WeakSet();
				const payload = JSON.parse(
					JSON.stringify(update, (_, v) => {
						if (typeof v === "bigint") return v.toString();
						if (typeof v === "object" && v !== null) {
							if (seen.has(v)) return "[Circular]";
							seen.add(v);
						}
						return v;
					}),
				);

				console.log(
					`\n[RawDebug] user=${this.telegramUserId} | className=${className}\n` +
						JSON.stringify(payload, null, 2),
				);
			} catch (error) {
				console.error(
					`[RawDebug] Failed to serialize ${className} for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(this.handler, new Raw({}));
		console.log(`[RawDebug] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(this.handler, new Raw({}));
			this.handler = null;
		}
	}
}
