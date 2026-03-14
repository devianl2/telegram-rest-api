import "dotenv/config";
import { Application } from "./app";
import { ApiKeyMiddleware } from "./http/middleware/ApiKeyMiddleware";
import { AuthRoute } from "./routes/auth/AuthRoute";
import { UserRoute } from "./routes/user/UserRoute";
import { MessageRoute } from "./routes/message/MessageRoute";
import { ChatRoute } from "./routes/message/ChatRoute";
import { TelegramClientService } from "./telegram/TelegramClientService";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function bootstrap(): Promise<void> {
	await TelegramClientService.restoreFromDatabase();

	const app = new Application();
	app
		.registerMiddleware(new ApiKeyMiddleware())
		.registerRoutes([new AuthRoute(), new UserRoute(), new MessageRoute(), new ChatRoute()]);

	await app.start(PORT);
}

bootstrap().catch((err: unknown) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
