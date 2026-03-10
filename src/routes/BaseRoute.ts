import { FastifyInstance, FastifyRequest } from "fastify";
import { TenantCache, CachedTenant } from "../redis/TenantCache";
import { ErrorResponse } from "../http/ApiResponse";

export abstract class BaseRoute {
	abstract register(fastify: FastifyInstance): Promise<void>;

	/**
	 * Returns the authenticated tenant for the current request.
	 * Safe to call inside any route handler — the middleware guarantees
	 * the tenant is cached in Redis before this point is reached.
	 */
	protected async getTenant(request: FastifyRequest): Promise<CachedTenant> {
		const secretId = request.headers["secret-id"] as string;
		const secretCode = request.headers["secret-code"] as string;
		const tenant = await TenantCache.get(secretId, secretCode);
		if (!tenant) {
			throw new Error("Failed to get tenant data.");
		}
		return tenant;
	}
}
