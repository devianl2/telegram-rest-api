import { FastifyReply, FastifyRequest } from "fastify";
import { ErrorResponse } from "../http/ApiResponse";
import { TenantService } from "../services/TenantService";

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

		try {
			const tenant = await TenantService.getTenant(secretId, secretCode);
			if (!tenant) {
				return new ErrorResponse("Unauthorized", 401).send(reply);
			}
		} catch (error) {
			console.error("Failed to resolve tenant:", (error as Error).message);
			return new ErrorResponse("Internal Server Error", 500).send(reply);
		}
	};
}
