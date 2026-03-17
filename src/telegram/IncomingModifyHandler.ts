import { Api, TelegramClient } from "telegram";
import { Raw } from "telegram/events";
import * as fs from "fs";
import * as path from "path";
import { DatabaseClient } from "../database/DatabaseClient";

const STORAGE_DIR = path.resolve(process.cwd(), "storage");

/**
 * Listens for modification events on existing content:
 *
 * Deletes:
 *   - UpdateDeleteMessages          — message(s) deleted in private chat / basic group
 *   - UpdateDeleteChannelMessages   — message(s) deleted in channel / supergroup
 *   - UpdateChatParticipants        — group dissolved or member removed/left
 *   - UpdateChannel                 — channel deleted, or member removed/left
 *
 * Edits:
 *   - UpdateEditMessage             — message edited in private chat / basic group
 *   - UpdateEditChannelMessage      — message edited in channel / supergroup
 *   - UpdateNewMessage (service)    — group/chat title or photo changed (service message)
 *   - UpdateNewChannelMessage (svc) — channel title or photo changed (service message)
 */
export class IncomingModifyHandler {
	private readonly client: TelegramClient;
	private readonly telegramUserId: string;
	private handler: ((update: Api.TypeUpdate) => void) | null = null;

	constructor(client: TelegramClient, telegramUserId: string) {
		this.client = client;
		this.telegramUserId = telegramUserId;
	}

	start(): void {
		this.handler = (update: Api.TypeUpdate) => {
			try {
				// ── Deletes ──────────────────────────────────────────────
				if (update instanceof Api.UpdateDeleteMessages) {
					// MTProto does NOT include chat_id here — resolved from DB
					void this.handleDeleteMessages(update);
				} else if (update instanceof Api.UpdateDeleteChannelMessages) {
					this.handleDeleteChannelMessages(update);
				} else if (update instanceof Api.UpdateChatParticipants) {
					this.handleChatParticipantsUpdate(update);
				} else if (update instanceof Api.UpdateChannel) {
					this.handleChannelUpdate(update);

				// ── Edits ────────────────────────────────────────────────
				} else if (update instanceof Api.UpdateEditMessage) {
					this.handleEditMessage(update);
				} else if (update instanceof Api.UpdateEditChannelMessage) {
					this.handleEditChannelMessage(update);
				} else if (
					update instanceof Api.UpdateNewMessage &&
					update.message instanceof Api.MessageService
				) {
					// Service messages carry title/photo change actions
					this.handleServiceMessage(update.message);
				} else if (
					update instanceof Api.UpdateNewChannelMessage &&
					update.message instanceof Api.MessageService
				) {
					this.handleServiceMessage(update.message);
				}
			} catch (error) {
				console.error(
					`[ModifyHandler] Error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(this.handler, new Raw({}));
		console.log(`[ModifyHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(this.handler, new Raw({}));
			this.handler = null;
		}
	}

	// ── Delete Handlers ────────────────────────────────────────────────

	private async handleDeleteMessages(
		update: Api.UpdateDeleteMessages,
	): Promise<void> {
		// MTProto omits chat_id for non-channel deletions — cross-reference
		// against our messages table to recover which chat(s) were affected.
		const messageIds = update.messages;
		let chatIds: string[] = [];

		try {
			const db = DatabaseClient.getInstance();
			const records = await db.execute(
				(prisma) =>
					prisma.message.findMany({
						where: {
							telegram_message_id: { in: messageIds },
							to_account: this.telegramUserId,
						},
						select: { telegram_chat_id: true },
						distinct: ["telegram_chat_id"],
					}) as Promise<{ telegram_chat_id: string }[]>,
			);
			chatIds = records.map((r) => r.telegram_chat_id);
		} catch {
			// Non-fatal — emit event with message IDs regardless
		}

		this.writeLog({
			type: "messages_deleted",
			to_account: this.telegramUserId,
			chat_ids: chatIds,
			message_ids: messageIds,
			date: Math.floor(Date.now() / 1000),
		});

		console.log(
			`[ModifyHandler] ${messageIds.length} message(s) deleted for user ${this.telegramUserId}` +
				(chatIds.length ? ` in chat(s) ${chatIds.join(", ")}` : ""),
		);
	}

	private handleDeleteChannelMessages(
		update: Api.UpdateDeleteChannelMessages,
	): void {
		const chatId = update.channelId.toString();
		const messageIds = update.messages;

		this.writeLog({
			type: "channel_messages_deleted",
			to_account: this.telegramUserId,
			chat_id: chatId,
			message_ids: messageIds,
			date: Math.floor(Date.now() / 1000),
		});

		console.log(
			`[ModifyHandler] ${messageIds.length} message(s) deleted in channel ${chatId} for user ${this.telegramUserId}`,
		);
	}

	private handleChatParticipantsUpdate(
		update: Api.UpdateChatParticipants,
	): void {
		const participants = update.participants;
		const chatId =
			participants instanceof Api.ChatParticipants
				? participants.chatId.toString()
				: null;

		this.writeLog({
			type: "chat_participants_updated",
			to_account: this.telegramUserId,
			chat_id: chatId,
			date: Math.floor(Date.now() / 1000),
		});

		console.log(
			`[ModifyHandler] Chat participants updated in chat ${chatId} for user ${this.telegramUserId}`,
		);
	}

	private handleChannelUpdate(update: Api.UpdateChannel): void {
		const channelId = update.channelId.toString();

		this.writeLog({
			type: "channel_updated",
			to_account: this.telegramUserId,
			chat_id: channelId,
			date: Math.floor(Date.now() / 1000),
		});

		console.log(
			`[ModifyHandler] Channel ${channelId} updated for user ${this.telegramUserId}`,
		);
	}

	// ── Edit Handlers ──────────────────────────────────────────────────

	private handleEditMessage(update: Api.UpdateEditMessage): void {
		if (!(update.message instanceof Api.Message)) return;

		const msg = update.message;
		const chatId = msg.chatId?.toString() ?? null;

		this.writeLog({
			type: "message_edited",
			to_account: this.telegramUserId,
			chat_id: chatId,
			message_id: msg.id,
			new_text: msg.message ?? null,
			edit_date: msg.editDate ?? null,
			date: Math.floor(Date.now() / 1000),
		});

		console.log(
			`[ModifyHandler] Message ${msg.id} edited in chat ${chatId} for user ${this.telegramUserId}`,
		);
	}

	private handleEditChannelMessage(
		update: Api.UpdateEditChannelMessage,
	): void {
		if (!(update.message instanceof Api.Message)) return;

		const msg = update.message;
		const chatId = msg.chatId?.toString() ?? null;

		this.writeLog({
			type: "channel_message_edited",
			to_account: this.telegramUserId,
			chat_id: chatId,
			message_id: msg.id,
			new_text: msg.message ?? null,
			edit_date: msg.editDate ?? null,
			date: Math.floor(Date.now() / 1000),
		});

		console.log(
			`[ModifyHandler] Channel message ${msg.id} edited in chat ${chatId} for user ${this.telegramUserId}`,
		);
	}

	private handleServiceMessage(message: Api.MessageService): void {
		const chatId = message.chatId?.toString() ?? null;
		const action = message.action;

		if (action instanceof Api.MessageActionChatEditTitle) {
			this.writeLog({
				type: "chat_title_changed",
				to_account: this.telegramUserId,
				chat_id: chatId,
				new_title: action.title,
				date: message.date,
			});

			console.log(
				`[ModifyHandler] Title changed to "${action.title}" in chat ${chatId} for user ${this.telegramUserId}`,
			);
		} else if (action instanceof Api.MessageActionChatEditPhoto) {
			this.writeLog({
				type: "chat_photo_changed",
				to_account: this.telegramUserId,
				chat_id: chatId,
				date: message.date,
			});

			console.log(
				`[ModifyHandler] Photo changed in chat ${chatId} for user ${this.telegramUserId}`,
			);
		} else if (action instanceof Api.MessageActionChatDeletePhoto) {
			this.writeLog({
				type: "chat_photo_deleted",
				to_account: this.telegramUserId,
				chat_id: chatId,
				date: message.date,
			});

			console.log(
				`[ModifyHandler] Photo deleted in chat ${chatId} for user ${this.telegramUserId}`,
			);
		}
	}

	// ── Helpers ────────────────────────────────────────────────────────

	private writeLog(payload: object): void {
		const logName = `modify_${this.telegramUserId}_${Date.now()}.log`;
		const logPath = path.join(STORAGE_DIR, logName);
		fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf-8");
	}
}
