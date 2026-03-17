import { Api } from "telegram";
import { FlushCallback } from "./interface/MessagePipeline";

/**
 * Collects Telegram messages that share a `grouped_id` (albums) and
 * flushes them as a batch after a short debounce window.  Messages
 * without a `grouped_id` are flushed immediately as single-element
 * arrays.
 */
export class AlbumBuffer {
	private readonly buffers = new Map<
		string,
		{ messages: Api.Message[]; timer: NodeJS.Timeout }
	>();

	constructor(
		private readonly flushDelayMs: number,
		private readonly onFlush: FlushCallback,
	) {}

	push(message: Api.Message): void {
		const groupedId = message.groupedId?.toString();

		if (!groupedId) {
			this.onFlush([message]).catch((err) =>
				console.error("[AlbumBuffer] Flush error (single):", err),
			);
			return;
		}

		const existing = this.buffers.get(groupedId);
		if (existing) {
			clearTimeout(existing.timer);
			existing.messages.push(message);
		} else {
			this.buffers.set(groupedId, { messages: [message], timer: null! });
		}

		const entry = this.buffers.get(groupedId)!;
		entry.timer = setTimeout(() => this.flush(groupedId), this.flushDelayMs);
	}

	private flush(groupedId: string): void {
		const entry = this.buffers.get(groupedId);
		if (!entry) return;
		this.buffers.delete(groupedId);

		this.onFlush(entry.messages).catch((err) =>
			console.error("[AlbumBuffer] Flush error (album):", err),
		);
	}
}
