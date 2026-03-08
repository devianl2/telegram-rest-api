import 'dotenv/config';
import { Application } from './app';
import { ApiKeyMiddleware } from './middleware/ApiKeyMiddleware';
import { AuthRoute } from './routes/auth/AuthRoute';

const APPLICATION_API_KEY = process.env.APPLICATION_API_KEY ?? '';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const app = new Application();
app
  .registerMiddleware(new ApiKeyMiddleware(APPLICATION_API_KEY))
  .registerRoutes([
    new AuthRoute(),
  ]);

app.start(PORT).catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
