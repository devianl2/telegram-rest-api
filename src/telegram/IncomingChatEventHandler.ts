import { Api, TelegramClient } from "telegram";
import { Raw } from "telegram/events";
import * as fs from "fs";
import * as path from "path";

const STORAGE_DIR = path.resolve(process.cwd(), "storage");

/**
 * Handles chat-level lifecycle events for a single Telegram session:
 *
 * New joiners:
 *   - MessageActionChatAddUser           — user added to basic group
 *   - MessageActionChatJoinedByLink      — user joined basic group via invite link
 *   - MessageActionChatJoinedByRequest   — user joined after approval
 *   - UpdateChannelParticipant (join)    — new member joined channel / supergroup
 *
 * Members leaving:
 *   - MessageActionChatDeleteUser        — user left or was removed from basic group
 *   - UpdateChannelParticipant (left)    — member left channel / supergroup voluntarily
 *   - UpdateChannelParticipant (kicked)  — member banned / removed from channel / supergroup
 *
 * Title / photo changes:
 *   - MessageActionChatEditTitle    — group or channel title changed
 *   - MessageActionChatEditPhoto    — group or channel photo changed
 *   - MessageActionChatDeletePhoto  — group or channel photo removed
 *
 * Chat / channel structural updates:
 *   - UpdateChatParticipants   — basic group participant list refreshed
 *   - UpdateChannel            — channel metadata or availability changed
 */
export class IncomingChatEventHandler {
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
				// ── Chat dissolution / member removal ─────────────────────
				if (update instanceof Api.UpdateChatParticipants) {
					this.handleChatParticipants(update);
				} else if (update instanceof Api.UpdateChannel) {
					void this.handleChannelUpdate(update);
				} else if (update instanceof Api.UpdateChannelParticipant) {
					this.handleChannelParticipant(update);

				// ── Service messages (title, photo, join, remove) ─────────
				} else if (
					update instanceof Api.UpdateNewMessage &&
					update.message instanceof Api.MessageService
				) {
					this.handleServiceMessage(update.message);
				} else if (
					update instanceof Api.UpdateNewChannelMessage &&
					update.message instanceof Api.MessageService
				) {
					this.handleServiceMessage(update.message);
				}
			} catch (error) {
				console.error(
					`[ChatEventHandler] Error for user ${this.telegramUserId}:`,
					error,
				);
			}
		};

		this.client.addEventHandler(this.handler, new Raw({}));
		console.log(`[ChatEventHandler] Started for user ${this.telegramUserId}`);
	}

	stop(): void {
		if (this.handler) {
			this.client.removeEventHandler(this.handler, new Raw({}));
			this.handler = null;
		}
	}

	// ── Deletion / member removal handlers ────────────────────────────

	private handleChatParticipants(update: Api.UpdateChatParticipants): void {
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
			raw: this.serialize(update),
		});

		console.log(
			`[ChatEventHandler] Participants updated in chat ${chatId} for user ${this.telegramUserId}`,
		);
	}

	private async handleChannelUpdate(update: Api.UpdateChannel): Promise<void> {
		const channelId = update.channelId.toString();

		// Try to resolve the channel to distinguish a deletion from a metadata update.
		// A deleted or inaccessible channel returns ChannelForbidden or throws.
		let type = "channel_updated";
		try {
			const entity = await this.client.getEntity(
				new Api.PeerChannel({ channelId: update.channelId }),
			);
			if (entity instanceof Api.ChannelForbidden) {
				type = "channel_deleted";
			}
		} catch {
			// Could not resolve — treat as deleted / inaccessible
			type = "channel_deleted";
		}

		this.writeLog({
			type,
			to_account: this.telegramUserId,
			chat_id: channelId,
			date: Math.floor(Date.now() / 1000),
			raw: this.serialize(update),
		});

		console.log(
			`[ChatEventHandler] ${type} for channel ${channelId}, user ${this.telegramUserId}`,
		);
	}

	private handleChannelParticipant(update: Api.UpdateChannelParticipant): void {
		const channelId = update.channelId.toString();
		const userId = update.userId?.toString() ?? null;

		const isJoin = !update.prevParticipant && !!update.newParticipant;
		const isGone = !!update.prevParticipant && !update.newParticipant;

		// When leaving: prevParticipant is a regular member (ChannelParticipant).
		// When kicked:  prevParticipant is ChannelParticipantBanned.
		const isKick =
			isGone &&
			update.prevParticipant instanceof Api.ChannelParticipantBanned;

		const type = isJoin
			? "channel_member_joined"
			: isKick
				? "channel_member_kicked"
				: isGone
					? "channel_member_left"
					: "channel_member_updated";

		this.writeLog({
			type,
			to_account: this.telegramUserId,
			chat_id: channelId,
			user_id: userId,
			date: update.date,
			raw: this.serialize(update),
		});

		console.log(
			`[ChatEventHandler] ${type} (user ${userId}) in channel ${channelId} for user ${this.telegramUserId}`,
		);
	}

	// ── Service message handler ────────────────────────────────────────

	private handleServiceMessage(message: Api.MessageService): void {
		const chatId = this.extractPeerId(message.peerId) ?? null;
		const action = message.action;

		// ── Title / photo changes ──────────────────────────────────────
		if (action instanceof Api.MessageActionChatEditTitle) {
			this.writeLog({
				type: "chat_title_changed",
				to_account: this.telegramUserId,
				chat_id: chatId,
				new_title: action.title,
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] Title changed to "${action.title}" in chat ${chatId} for user ${this.telegramUserId}`,
			);

		} else if (action instanceof Api.MessageActionChatEditPhoto) {
			this.writeLog({
				type: "chat_photo_changed",
				to_account: this.telegramUserId,
				chat_id: chatId,
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] Photo changed in chat ${chatId} for user ${this.telegramUserId}`,
			);

		} else if (action instanceof Api.MessageActionChatDeletePhoto) {
			this.writeLog({
				type: "chat_photo_deleted",
				to_account: this.telegramUserId,
				chat_id: chatId,
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] Photo deleted in chat ${chatId} for user ${this.telegramUserId}`,
			);

		// ── New joiners ────────────────────────────────────────────────
		} else if (action instanceof Api.MessageActionChatAddUser) {
			this.writeLog({
				type: "chat_member_added",
				to_account: this.telegramUserId,
				chat_id: chatId,
				user_ids: action.users.map((u) => u.toString()),
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] ${action.users.length} member(s) added to chat ${chatId} for user ${this.telegramUserId}`,
			);

		} else if (action instanceof Api.MessageActionChatJoinedByLink) {
			this.writeLog({
				type: "chat_member_joined_by_link",
				to_account: this.telegramUserId,
				chat_id: chatId,
				inviter_id: action.inviterId?.toString() ?? null,
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] Member joined via link in chat ${chatId} for user ${this.telegramUserId}`,
			);

		} else if (action instanceof Api.MessageActionChatJoinedByRequest) {
			this.writeLog({
				type: "chat_member_joined_by_request",
				to_account: this.telegramUserId,
				chat_id: chatId,
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] Member joined by request in chat ${chatId} for user ${this.telegramUserId}`,
			);

		// ── Member left / removed (basic group) ───────────────────────
		// MTProto uses the same action for both voluntary leave and admin kick;
		// the distinction is not available at the protocol level for basic groups.
		} else if (action instanceof Api.MessageActionChatDeleteUser) {
			const userId = action.userId?.toString() ?? null;
			this.writeLog({
				type: "chat_member_left",
				to_account: this.telegramUserId,
				chat_id: chatId,
				user_id: userId,
				date: message.date,
				raw: this.serialize(message),
			});
			console.log(
				`[ChatEventHandler] Member ${userId} left/removed from chat ${chatId} for user ${this.telegramUserId}`,
			);
		}
	}

	// ── Helpers ────────────────────────────────────────────────────────

	private serialize(value: unknown): unknown {
		return JSON.parse(
			JSON.stringify(value, (_, v) =>
				typeof v === "bigint" ? v.toString() : v,
			),
		);
	}

	private extractPeerId(peer: Api.TypePeer | null | undefined): string | null {
		if (!peer) return null;
		if (peer instanceof Api.PeerUser) return peer.userId.toString();
		if (peer instanceof Api.PeerChat) return peer.chatId.toString();
		if (peer instanceof Api.PeerChannel) return peer.channelId.toString();
		return null;
	}

	private writeLog(payload: object): void {
		const logName = `chat_event_${this.telegramUserId}_${Date.now()}.log`;
		const logPath = path.join(STORAGE_DIR, logName);
		fs.writeFileSync(logPath, JSON.stringify(payload, null, 2), "utf-8");
	}
}
