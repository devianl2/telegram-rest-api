import { TelegramClientService } from "./TelegramClientService";
import { IncomingMessageHandler } from "./IncomingMessageHandler";
import { DatabaseClient } from "../database/DatabaseClient";
import { SessionStatus } from "../database/constants/SessionStatus";

interface TelegramSessionRecord {
	id: number;
	tenant_id: number;
	session_id: string;
	telegram_user_id: string;
	telegram_username: string;
	status: string;
}

// Holds live authenticated TelegramClient instances keyed by session string.
// Clients in the pool remain connected for real-time use (send/receive messages).
// On startup, active sessions are restored from the database via restoreFromDatabase().
export class TelegramSessionPool {
	private static instance: TelegramSessionPool;
	private readonly pool = new Map<string, TelegramClientService>();
	private readonly messageHandlers = new Map<string, IncomingMessageHandler>();

	private constructor() {}

	static getInstance(): TelegramSessionPool {
		if (!TelegramSessionPool.instance) {
			TelegramSessionPool.instance = new TelegramSessionPool();
		}
		return TelegramSessionPool.instance;
	}

	async add(sessionId: string, client: TelegramClientService, telegramUserId?: string): Promise<void> {
		this.pool.set(sessionId, client);

		if (telegramUserId) {
			await this.startMessageHandler(sessionId, client, telegramUserId);
		}
	}

	private async startMessageHandler(
		sessionId: string,
		client: TelegramClientService,
		telegramUserId: string,
	): Promise<void> {
		const handler = new IncomingMessageHandler(client.getClient(), telegramUserId);
		await handler.start();
		this.messageHandlers.set(sessionId, handler);
	}

	get(sessionId: string): TelegramClientService | undefined {
		return this.pool.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.pool.has(sessionId);
	}

	async remove(sessionId: string): Promise<void> {
		this.stopMessageHandler(sessionId);
		const client = this.pool.get(sessionId);
		if (client) {
			await client.disconnect();
			this.pool.delete(sessionId);
		}
	}

	private stopMessageHandler(sessionId: string): void {
		const handler = this.messageHandlers.get(sessionId);
		if (handler) {
			handler.stop();
			this.messageHandlers.delete(sessionId);
		}
	}

	size(): number {
		return this.pool.size;
	}

	// Returns the pooled client if available, otherwise creates a temporary one.
	// The boolean indicates whether the client is from the pool (true = keep alive,
	// false = temporary, caller must disconnect after use).
	async resolve(
		sessionId: string,
	): Promise<{ client: TelegramClientService; fromPool: boolean }> {
		const pooled = this.pool.get(sessionId);
		if (pooled) {
			return { client: pooled, fromPool: true };
		}

		const client = TelegramClientService.initialize(sessionId);
		await client.connect();
		return { client, fromPool: false };
	}

	async restoreFromDatabase(): Promise<void> {
		const serverName = process.env.SERVER_NAME ?? "";
		if (serverName) {
			const db = DatabaseClient.getInstance();
			const sessions = await db.execute<TelegramSessionRecord[]>((prisma) =>
				prisma.telegramSession.findMany({
					where: {
						status: SessionStatus.ACTIVE,
						tenant: { server_name: process.env.SERVER_NAME ?? "" },
					},
				}),
			);

			for (const session of sessions) {
				try {
					const client = TelegramClientService.initialize(session.session_id);
					await client.connect();
					await this.add(session.session_id, client, session.telegram_user_id);
				} catch (error) {
					console.error(`Failed to restore session id=${session.id}:`, error);
				}
			}

			console.log(
				`Session restore complete: ${this.pool.size}/${sessions.length} restored`,
			);
		} else {
			console.log("No telegram sessions to restore");
		}
	}

	// Disconnects the client, removes from pool, and deletes the session from the database.
	async invalidate(sessionId: string): Promise<void> {
		this.stopMessageHandler(sessionId);
		const client = this.pool.get(sessionId);
		if (client) {
			await client.disconnect();
			this.pool.delete(sessionId);
		}

		const db = DatabaseClient.getInstance();
		await db.execute((prisma) =>
			prisma.telegramSession.deleteMany({
				where: { session_id: sessionId },
			}),
		);
	}
}
