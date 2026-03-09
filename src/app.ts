import Fastify, {
	FastifyError,
	FastifyInstance,
	FastifyReply,
	FastifyRequest,
} from "fastify";
import { BaseRoute } from "./routes/BaseRoute";
import { ApiKeyMiddleware } from "./middleware/ApiKeyMiddleware";
import { ErrorResponse } from "./http/ApiResponse";

export class Application {
	private readonly server: FastifyInstance;

	constructor() {
		this.server = Fastify({ logger: true });
		this.registerErrorHandlers();
	}

	private registerErrorHandlers(): void {
		this.server.setNotFoundHandler(
			(_request: FastifyRequest, reply: FastifyReply) => {
				new ErrorResponse("Route not found", 404).send(reply);
			},
		);

		this.server.setErrorHandler(
			(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
				const statusCode = error.statusCode ?? 500;
				const message =
					statusCode >= 500 ? "Internal Server Error" : error.message;
				new ErrorResponse(message, statusCode).send(reply);
			},
		);
	}

	registerMiddleware(middleware: ApiKeyMiddleware): this {
		this.server.addHook("onRequest", middleware.handle);
		return this;
	}

	registerRoutes(routes: BaseRoute[]): this {
		for (const route of routes) {
			this.server.register(async (fastify: FastifyInstance) => {
				await route.register(fastify);
			});
		}
		return this;
	}

	async start(port: number, host = "0.0.0.0"): Promise<void> {
		await this.server.listen({ port, host });
	}
}
