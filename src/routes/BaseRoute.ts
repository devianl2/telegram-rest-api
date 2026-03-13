import { FastifyInstance, FastifyRequest } from "fastify";
import { TenantService, Tenant } from "../services/TenantService";
import { TelegramClientService } from "../telegram/TelegramClientService";
import { TelegramUtils } from "../telegram/TelegramUtils";

export abstract class BaseRoute {
	abstract register(fastify: FastifyInstance): Promise<void>;
	/**
	 * Resolves a Telegram client for the given session and executes the
	 * operation. Temporary (non-pooled) clients are destroyed after use;
	 * unauthorised sessions are invalidated automatically.
	 * Caution: Use this method for authorized sessions only (E.g send message, get user info, logout, etc.).
	 */
	protected async withTelegramSession<T>(
		sessionId: string,
		operation: (client: TelegramClientService) => Promise<T>,
	): Promise<T> {
		const isPooled = TelegramClientService.isPooled(sessionId);
		const client = await TelegramClientService.initialize(sessionId);
		try {
			return await operation(client);
		} catch (error: unknown) {
			if (TelegramUtils.isUnauthorized(error)) {
				await TelegramClientService.invalidate(sessionId);
			}
			throw error;
		} finally {
			if (!isPooled) await client.destroy();
		}
	}

	/**
	 * Returns the authenticated tenant for the current request.
	 * Safe to call inside any route handler — the middleware guarantees
	 * the tenant is cached before this point is reached.
	 */
	protected async getTenant(request: FastifyRequest): Promise<Tenant> {
		const secretId = request.headers["secret-id"] as string;
		const secretCode = request.headers["secret-code"] as string;

		const tenant = await TenantService.getTenant(secretId, secretCode);
		if (!tenant) {
			throw new Error("Invalid secret id or code.");
		}
		return tenant;
	}
}
