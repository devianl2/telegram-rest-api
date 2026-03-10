import { FastifyReply, FastifyRequest } from "fastify";
import { ErrorResponse } from "../http/ApiResponse";
import { DatabaseClient } from "../database/DatabaseClient";
import { TenantCache, CachedTenant } from "../redis/TenantCache";

export abstract class BaseMiddleware {
	abstract handle(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export class ApiKeyMiddleware extends BaseMiddleware {
	handle = async (
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> => {
		const secretId = request.headers["secret-id"] as string | undefined;
		const secretCode = request.headers["secret-code"] as string | undefined;
		const acceptHeader = request.headers["accept"];

		if (!secretId || !secretCode) {
			return new ErrorResponse("Unauthorized", 401).send(reply);
		}

		if (acceptHeader !== "application/json") {
			return new ErrorResponse(
				"Accept header must be application/json",
				400,
			).send(reply);
		}

		// If the tenant is cached, return it
		const cached = await TenantCache.get(secretId, secretCode);
		if (cached) return;

		const db = DatabaseClient.getInstance();
		let tenant: CachedTenant | null = null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			tenant = await db.execute(
				(prisma) =>
					(prisma as any).tenant.findFirst({
						where: { secret_id: secretId, secret_code: secretCode },
					}) as Promise<CachedTenant | null>,
			);
		} catch (dbError) {
			const errorMessage =
				dbError instanceof Error ? dbError.message : "Unknown database error";
			return new ErrorResponse("Database error: " + errorMessage, 500).send(
				reply,
			);
		}

		if (!tenant) {
			return new ErrorResponse("Unauthorized", 401).send(reply);
		}

		await TenantCache.set(secretId, secretCode, {
			id: tenant.id,
			secret_id: tenant.secret_id,
			secret_code: tenant.secret_code,
			callback_url: tenant.callback_url,
		});
	};
}
