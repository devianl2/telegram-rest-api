import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { TelegramClientInterface } from "./interface/Telegram";

export class TelegramClientService implements TelegramClientInterface {
	private readonly client: TelegramClient;

	constructor(
		private readonly apiId: number,
		private readonly apiHash: string,
		private readonly session: string,
	) {
		this.client = new TelegramClient(
			new StringSession(this.session),
			this.apiId,
			this.apiHash,
			{
				connectionRetries: 5,
				retryDelay: 1000,
				timeout: 30,
				useWSS: false,
			},
		);
	}

	static initialize(session: string = ""): TelegramClientService {
		const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
		const apiHash = process.env.TELEGRAM_API_HASH ?? "";

		if (!apiId || !apiHash) {
			throw new Error(
				"TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment variables",
			);
		}

		return new TelegramClientService(apiId, apiHash, session);
	}

	async connect(): Promise<void> {
		await this.client.connect();
	}

	async disconnect(): Promise<void> {
		await this.client.disconnect();
	}

	getClient(): TelegramClient {
		return this.client;
	}

	getSession(): string {
		return (this.client.session as StringSession).save();
	}
}
