import { TelegramClientService } from "./TelegramClientService";
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

	private constructor() {}

	static getInstance(): TelegramSessionPool {
		if (!TelegramSessionPool.instance) {
			TelegramSessionPool.instance = new TelegramSessionPool();
		}
		return TelegramSessionPool.instance;
	}

	add(sessionId: string, client: TelegramClientService): void {
		this.pool.set(sessionId, client);
	}

	get(sessionId: string): TelegramClientService | undefined {
		return this.pool.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.pool.has(sessionId);
	}

	async remove(sessionId: string): Promise<void> {
		const client = this.pool.get(sessionId);
		if (client) {
			await client.disconnect();
			this.pool.delete(sessionId);
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
		const db = DatabaseClient.getInstance();
		const sessions = await db.execute<TelegramSessionRecord[]>((prisma) =>
			prisma.telegramSession.findMany({
				where: { status: SessionStatus.ACTIVE },
			}),
		);

		for (const session of sessions) {
			try {
				const client = TelegramClientService.initialize(session.session_id);
				await client.connect();
				this.pool.set(session.session_id, client);
			} catch (error) {
				console.error(`Failed to restore session id=${session.id}:`, error);
			}
		}
		console.log(
			`Session restore complete: ${this.pool.size}/${sessions.length} restored`,
		);
	}

	// Disconnects the client, removes from pool, and deletes the session from the database.
	async invalidate(sessionId: string): Promise<void> {
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
