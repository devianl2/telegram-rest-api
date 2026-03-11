import { FastifyInstance, FastifyRequest } from "fastify";
import { TenantService, Tenant } from "../services/TenantService";

export abstract class BaseRoute {
	abstract register(fastify: FastifyInstance): Promise<void>;

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
			throw new Error("Tenant not found.");
		}
		return tenant;
	}
}
