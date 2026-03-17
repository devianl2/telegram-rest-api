import { Api } from "telegram";
import bigInt from "big-integer";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BaseRoute } from "../BaseRoute";
import { SuccessResponse, ErrorResponse } from "../../http/ApiResponse";
/**
 * All routes require a valid session ID.
 * The session ID identifies the user and authorises the operation.
 */
export class UserRoute extends BaseRoute {
	async register(fastify: FastifyInstance): Promise<void> {
		/**
		 * Fetches a full user by their ID.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/users/GetFullUser",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string;
				};

				if (!sessionId || !id) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(new Api.users.GetFullUser({ id })),
					);

					new SuccessResponse([result], "User fetched successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Returns basic user info according to their identifiers ids or usernames.
		 * @param request - The request object
		 * @param reply - The reply object
		 * @returns The response object
		 */
		fastify.post(
			"/users/GetUsers",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, id } = request.body as {
					sessionId: string;
					id: string[];
				};

				if (!sessionId || !id?.length) {
					return new ErrorResponse("sessionId and id are required", 400).send(
						reply,
					);
				}

				try {
					const result = await this.withTelegramSession(sessionId, (client) =>
						client.getClient().invoke(new Api.users.GetUsers({ id })),
					);

					new SuccessResponse(result, "Users fetched successfully").send(reply);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);

		/**
		 * Resolves a user by username or phone number. Exactly one of
		 */
		fastify.post(
			"/users/ResolveUser",
			async (request: FastifyRequest, reply: FastifyReply) => {
				const { sessionId, username, phoneNumber } = request.body as {
					sessionId: string;
					username?: string;
					phoneNumber?: string;
				};

				if (!sessionId) {
					return new ErrorResponse("sessionId is required", 400).send(reply);
				}

				const hasUsername = !!username?.trim();
				const hasPhone = !!phoneNumber?.trim();

				if (!hasUsername && !hasPhone) {
					return new ErrorResponse(
						"Provide either username or phoneNumber",
						400,
					).send(reply);
				}

				if (hasUsername && hasPhone) {
					return new ErrorResponse(
						"Provide only one of username or phoneNumber, not both",
						400,
					).send(reply);
				}

				try {
					if (hasUsername) {
						const result = await this.withTelegramSession(sessionId, (client) =>
							client.getClient().invoke(
								new Api.contacts.ResolveUsername({
									username: username!.replace(/^@/, ""),
								}),
							),
						);
						return new SuccessResponse(
							result,
							"User resolved successfully",
						).send(reply);
					}

					// Phone number lookup: import contact, fetch result, then delete
					const result = await this.withTelegramSession(
						sessionId,
						async (client) => {
							const tg = client.getClient();

							const imported = await tg.invoke(
								new Api.contacts.ImportContacts({
									contacts: [
										new Api.InputPhoneContact({
											clientId: bigInt(Date.now()),
											phone: phoneNumber!,
											firstName: "",
											lastName: "",
										}),
									],
								}),
							);

							const user = imported.users[0] ?? null;
							const wasNewlyImported = imported.imported.length > 0;

							// Only delete if we actually added a new contact.
							// If the contact already existed, leave it untouched.
							if (wasNewlyImported && user) {
								try {
									await tg.invoke(
										new Api.contacts.DeleteContacts({
											id: [
												new Api.InputUser({
													userId: (user as Api.User).id,
													accessHash: (user as Api.User).accessHash!,
												}),
											],
										}),
									);
								} catch {
									// Non-fatal: log but don't fail the whole request
									console.warn(
										`[ResolveUser] Failed to delete temporarily imported contact for phone ${phoneNumber}`,
									);
								}
							}

							return { user, wasAlreadyContact: !wasNewlyImported };
						},
					);

					return new SuccessResponse(result, "User resolved successfully").send(
						reply,
					);
				} catch (error: unknown) {
					ErrorResponse.fromError(error).send(reply);
				}
			},
		);
	}
}
