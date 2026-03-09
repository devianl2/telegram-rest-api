import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { TelegramSessionPool } from "../../telegram/TelegramSessionPool";
import { DatabaseClient } from "../../database/DatabaseClient";
import { SessionStatus } from "../../database/constants/SessionStatus";

interface SendCodeBody {
	phoneNumber: string;
}

interface ResendCodeBody {
	phoneNumber: string;
	phoneCodeHash: string;
	sessionCode: string;
}

interface SignInBody {
	phoneNumber: string;
	phoneCode: string;
	phoneCodeHash: string;
	sessionCode: string;
}

/**
 * Force telegram session to disconnect after each request to avoid memory leaks
 * Only successfully signed in accounts are added to the pool
 */
export class AuthRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		fastify.post(
			"/auth/SendCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber } = request.body as SendCodeBody;

				if (!phoneNumber) {
					return new ErrorResponse("phoneNumber is required", 400).send(reply);
				}

				const telegram = TelegramClientService.initialize();
				await telegram.connect();

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.SendCode({
							phoneNumber,
							apiId: parseInt(process.env.TELEGRAM_API_ID ?? "", 10),
							apiHash: process.env.TELEGRAM_API_HASH ?? "",
							settings: new Api.CodeSettings({}),
						}),
					);

					new SuccessResponse(
						[
							{
								phoneCodeHash: result.phoneCodeHash,
								session: telegram.getSession(),
							},
						],
						"Verification code sent",
					).send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				} finally {
					await telegram.disconnect();
				}
			},
		);

		fastify.post(
			"/auth/ResendCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, sessionCode } =
					request.body as ResendCodeBody;

				if (!phoneNumber) {
					return new ErrorResponse("phoneNumber is required", 400).send(reply);
				}

				// Initialize the Telegram client with the session code that was sent in send-code route
				const telegram = TelegramClientService.initialize(sessionCode);
				await telegram.connect();

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.ResendCode({
							phoneNumber: phoneNumber,
							phoneCodeHash: phoneCodeHash,
						}),
					);

					new SuccessResponse([result], "Verification code resent").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				} finally {
					await telegram.disconnect();
				}
			},
		);

		fastify.post(
			"/auth/SignIn",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, phoneCode, sessionCode } =
					request.body as SignInBody;

				if (!phoneNumber || !phoneCodeHash || !phoneCode || !sessionCode) {
					return new ErrorResponse(
						"phoneNumber, phoneCode, and session code are required",
						400,
					).send(reply);
				}

				// Initialize the Telegram client with the session code that was sent in send-code route
				const telegram = TelegramClientService.initialize(sessionCode);
				await telegram.connect();

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.SignIn({
							phoneNumber: phoneNumber,
							phoneCode: phoneCode,
							phoneCodeHash: phoneCodeHash,
						}),
					);

					const sessionId = telegram.getSession();

					const db = DatabaseClient.getInstance();
					await db.execute((prisma) =>
						prisma.telegramSession.create({
							data: {
								session_id: sessionId,
								server_name: process.env.SERVER_NAME ?? "default",
								status: SessionStatus.ACTIVE,
							},
						}),
					);

					// Add the session to the pool
					TelegramSessionPool.getInstance().add(sessionId, telegram);

					new SuccessResponse(
						[{ ...result, sessionId }],
						"Signed in successfully",
					).send(reply);
				} catch (error: unknown) {
					await telegram.disconnect();
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
