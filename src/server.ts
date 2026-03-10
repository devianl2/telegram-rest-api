import "dotenv/config";
import { Application } from "./app";
import { ApiKeyMiddleware } from "./middleware/ApiKeyMiddleware";
import { AuthRoute } from "./routes/auth/AuthRoute";
import { UserRoute } from "./routes/user/UserRoute";
import { TelegramSessionPool } from "./telegram/TelegramSessionPool";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function bootstrap(): Promise<void> {
	await TelegramSessionPool.getInstance().restoreFromDatabase();

	const app = new Application();
	app
		.registerMiddleware(new ApiKeyMiddleware())
		.registerRoutes([new AuthRoute(), new UserRoute()]);

	await app.start(PORT);
}

bootstrap().catch((err: unknown) => {
	console.error("Failed to start server:", err);
	process.exit(1);
});
