import { Api } from "telegram";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
import { TelegramClientService } from "../../telegram/TelegramClientService";
import { TelegramSessionPool } from "../../telegram/TelegramSessionPool";
import { TelegramUtils } from "../../telegram/TelegramUtils";
import { DatabaseClient } from "../../database/DatabaseClient";
import { SessionStatus } from "../../database/constants/SessionStatus";

/**
 * Force telegram session to disconnect after each request to avoid memory leaks
 * Only successfully signed in accounts are added to the pool
 */
export class AuthRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Sends a one-time verification code to the given phone number (Telegram login flow).
		 * This is the first step in the authentication process.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/SendCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber } = request.body as { phoneNumber: string };

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

		/**
		 * Resend the login code via another medium,
		 * the phone code type is determined by the return value of the previous auth.sendCode/auth.resendCode
		 * The session code must be the same as the one used in the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/ResendCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, sessionCode } = request.body as {
					phoneNumber: string;
					phoneCodeHash: string;
					sessionCode: string;
				};

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

		/**
		 * Signs in a user with a validated phone number.
		 * Inherits the session code from the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/SignIn",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, phoneCode, sessionCode } =
					request.body as {
						phoneNumber: string;
						phoneCodeHash: string;
						phoneCode: string;
						sessionCode: string;
					};

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

					const tenant = await this.getTenant(request);
					const sessionId = telegram.getSession();
					const db = DatabaseClient.getInstance();
					await db.execute((prisma) =>
						prisma.telegramSession.create({
							data: {
								tenant_id: tenant.id,
								session_id: sessionId,
								telegram_user_id: result.user.id.toString(),
								telegram_username: result.user.username ?? "",
								telegram_access_hash: result.user.accessHash.toString() ?? "",
								status: SessionStatus.ACTIVE,
							},
						}),
					);

					// Add the session to the pool
					TelegramSessionPool.getInstance().add(sessionId, telegram);

					new SuccessResponse(
						[{ result, sessionId }],
						"Signed in successfully",
					).send(reply);
				} catch (error: unknown) {
					await telegram.disconnect();
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Registers a validated phone number in the system.
		 * Inherits the session code from the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/SignUp",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, firstName, lastName, sessionCode } =
					request.body as {
						phoneNumber: string;
						phoneCodeHash: string;
						firstName: string;
						lastName: string;
						sessionCode: string;
					};

				if (!phoneNumber || !phoneCodeHash || !firstName || !sessionCode) {
					return new ErrorResponse(
						"phoneNumber, phoneCodeHash, firstName, and sessionCode are required",
						400,
					).send(reply);
				}

				const telegram = TelegramClientService.initialize(sessionCode);
				await telegram.connect();

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.SignUp({
							phoneNumber,
							phoneCodeHash,
							firstName,
							lastName: lastName ?? "",
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

					TelegramSessionPool.getInstance().add(sessionId, telegram);

					new SuccessResponse(
						[{ result, sessionId }],
						"Signed up successfully",
					).send(reply);
				} catch (error: unknown) {
					await telegram.disconnect();
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Cancels the login code sent to the user.
		 * Inherits the session code from the send-code route.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/CancelCode",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { phoneNumber, phoneCodeHash, sessionCode } = request.body as {
					phoneNumber: string;
					phoneCodeHash: string;
					sessionCode: string;
				};

				if (!phoneNumber || !phoneCodeHash || !sessionCode) {
					return new ErrorResponse(
						"phoneNumber, phoneCodeHash, and sessionCode are required",
						400,
					).send(reply);
				}

				const telegram = TelegramClientService.initialize(sessionCode);
				await telegram.connect();

				try {
					const result = await telegram.getClient().invoke(
						new Api.auth.CancelCode({
							phoneNumber,
							phoneCodeHash,
						}),
					);

					new SuccessResponse([result], "Verification code cancelled").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				} finally {
					await telegram.disconnect();
				}
			},
		);

		/**
		 * Terminates all user's authorized sessions except for the current one.
		 * The current session must be authorized.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/ResetAuthorizations",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionCode } = request.body as { sessionCode: string };

				if (!sessionCode) {
					return new ErrorResponse("sessionCode is required", 400).send(reply);
				}

				const pool = TelegramSessionPool.getInstance();
				const { client, fromPool } = await pool.resolve(sessionCode);

				try {
					const result = await client
						.getClient()
						.invoke(new Api.auth.ResetAuthorizations({}));

					new SuccessResponse([result], "All other sessions terminated").send(
						reply,
					);
				} catch (error: unknown) {
					if (TelegramUtils.isUnauthorized(error)) {
						await pool.invalidate(sessionCode);
					}
					ErrorResponse.fromError(error).send(reply);
				} finally {
					if (!fromPool) await client.disconnect();
				}
			},
		);

		/**
		 * Terminates the current session.
		 * The current session must be authorized.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/auth/LogOut",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionCode } = request.body as { sessionCode: string };

				if (!sessionCode) {
					return new ErrorResponse("sessionCode is required", 400).send(reply);
				}

				const pool = TelegramSessionPool.getInstance();
				const { client, fromPool } = await pool.resolve(sessionCode);

				try {
					const result = await client
						.getClient()
						.invoke(new Api.auth.LogOut({}));

					await pool.invalidate(sessionCode);

					new SuccessResponse([result], "Logged out successfully").send(reply);
				} catch (error: unknown) {
					if (TelegramUtils.isUnauthorized(error)) {
						await pool.invalidate(sessionCode);
					}
					ErrorResponse.fromError(error).send(reply);
				} finally {
					if (!fromPool) await client.disconnect();
				}
			},
		);
	}
}
