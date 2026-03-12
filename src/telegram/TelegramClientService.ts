import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TelegramSessionPool } from "./TelegramSessionPool";
import { TelegramClientInterface } from "./interface/Telegram";

export class TelegramClientService implements TelegramClientInterface {
	private readonly client: TelegramClient;

	constructor(
		private readonly apiId: number,
		private readonly apiHash: string,
		private readonly sessionId: string,
	) {
		this.client = new TelegramClient(
			new StringSession(this.sessionId),
			this.apiId,
			this.apiHash,
			{
				connectionRetries: 5,
				retryDelay: 5000,
			},
		);
	}

	/**
	 * Initializes a new Telegram client service .
	 * @param sessionId - The session string
	 * @returns
	 */
	static async initialize(
		sessionId: string = "",
	): Promise<TelegramClientService> {
		const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
		const apiHash = process.env.TELEGRAM_API_HASH ?? "";

		if (!apiId || !apiHash) {
			throw new Error(
				"TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables",
			);
		}

		if (sessionId !== "" && TelegramSessionPool.getInstance().has(sessionId)) {
			return TelegramSessionPool.getInstance().get(
				sessionId,
			) as TelegramClientService;
		} else {
			const client = new TelegramClientService(apiId, apiHash, sessionId);
			await client.connect();
			return client;
		}
	}

	async connect(): Promise<void> {
		await this.client.connect();
	}

	async destroy(): Promise<void> {
		await this.client.destroy();
	}

	getClient(): TelegramClient {
		return this.client;
	}

	getSession(): string {
		return (this.client.session as StringSession).save();
	}
}
