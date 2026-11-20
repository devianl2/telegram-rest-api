import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import { Api } from "teleproto";
import { MessageRoute } from "../../src/routes/message/MessageRoute";
import { TelegramClientService } from "../../src/telegram/TelegramClientService";

describe("POST /messages/SendMessage session guard", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = Fastify();
		await new MessageRoute().register(app);
	});

	afterEach(async () => {
		await app.close();
		vi.restoreAllMocks();
	});

	function sendMessage() {
		return app.inject({
			method: "POST",
			url: "/messages/SendMessage",
			payload: { sessionId: "session", peer: "456", message: "hello" },
		});
	}

	function fakeClientService(invoke = vi.fn().mockResolvedValue({})) {
		const destroy = vi.fn().mockResolvedValue(undefined);
		const clientService = {
			captureSentResult: vi.fn(),
			destroy,
			getClient: () => ({
				getInputEntity: vi.fn().mockResolvedValue(new Api.InputPeerSelf()),
				invoke,
			}),
		} as unknown as TelegramClientService;
		return { clientService, invoke, destroy };
	}

	it("passes a Telegram 401 on to the caller without removing the session", async () => {
		const invalidate = vi.spyOn(TelegramClientService, "invalidate").mockResolvedValue(true);
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(true);
		const { clientService } = fakeClientService(
			vi.fn().mockRejectedValue(Object.assign(new Error("AUTH_KEY_UNREGISTERED"), { code: 401 })),
		);
		vi.spyOn(TelegramClientService, "initialize").mockResolvedValue(clientService);

		const response = await sendMessage();

		expect(response.statusCode).toBe(401);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("keeps a client that joined the pool while the session was being looked up", async () => {
		const { clientService, destroy } = fakeClientService();
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValueOnce(false).mockReturnValue(true);
		vi.spyOn(TelegramClientService, "findSessionRecord").mockResolvedValue({
			callback_url: "https://example.com/callback",
			telegram_user_id: "42",
		});
		vi.spyOn(TelegramClientService, "initialize").mockResolvedValue(clientService);

		const response = await sendMessage();

		expect(response.statusCode).toBe(200);
		expect(destroy).not.toHaveBeenCalled();
	});

	it("refuses a session this server no longer holds without opening a Telegram client", async () => {
		const { clientService, invoke } = fakeClientService();
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(false);
		vi.spyOn(TelegramClientService, "findSessionRecord").mockResolvedValue(null);
		const initialize = vi.spyOn(TelegramClientService, "initialize").mockResolvedValue(clientService);

		const response = await sendMessage();

		expect(response.statusCode).toBe(401);
		expect(response.json().message).toBe(
			"Session not found on this server. Please reconnect the channel.",
		);
		expect(initialize).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
	});

	it("answers 503 without the session string when the session lookup fails in the database", async () => {
		const sessionId = "distinctive-session-string-9f3a";
		const { clientService } = fakeClientService();
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(false);
		vi.spyOn(TelegramClientService, "findSessionRecord").mockRejectedValue(
			new DrizzleQueryError(
				'select "callback_url" from "telegram_sessions" where "session_id" = $1 and "server_name" = $2 limit $3',
				[sessionId, "server-a", 1],
				new Error("connect ECONNREFUSED"),
			),
		);
		const initialize = vi.spyOn(TelegramClientService, "initialize").mockResolvedValue(clientService);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await app.inject({
			method: "POST",
			url: "/messages/SendMessage",
			payload: { sessionId, peer: "456", message: "hello" },
		});

		expect(response.statusCode).toBe(503);
		expect(response.json().message).toBe("Session lookup failed. Please try again.");
		expect(response.body).not.toContain(sessionId);
		expect(initialize).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledWith("[BaseRoute] Session lookup failed: connect ECONNREFUSED");
		expect(inspect(consoleError.mock.calls, { depth: 5 })).not.toContain(sessionId);
	});

	it("sends through a temporary client for a stored session that is not pooled, then destroys it", async () => {
		const { clientService, destroy } = fakeClientService();
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(false);
		vi.spyOn(TelegramClientService, "findSessionRecord").mockResolvedValue({
			callback_url: "https://example.com/callback",
			telegram_user_id: "42",
		});
		vi.spyOn(TelegramClientService, "initialize").mockResolvedValue(clientService);

		const response = await sendMessage();

		expect(response.statusCode).toBe(200);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	it("does not look the session up when it is pooled", async () => {
		const { clientService } = fakeClientService();
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(true);
		const findSessionRecord = vi.spyOn(TelegramClientService, "findSessionRecord");
		vi.spyOn(TelegramClientService, "initialize").mockResolvedValue(clientService);

		const response = await sendMessage();

		expect(response.statusCode).toBe(200);
		expect(findSessionRecord).not.toHaveBeenCalled();
	});
});

describe("POST /messages/SendMessage voice notes", () => {
	let app: FastifyInstance;
	const invoke = vi.fn();

	function sentDurations(): number[] {
		return invoke.mock.calls.map(([request]) => {
			const media = (request as Api.messages.SendMedia).media as Api.InputMediaUploadedDocument;
			return (media.attributes[0] as Api.DocumentAttributeAudio).duration;
		});
	}

	beforeEach(async () => {
		invoke.mockReset().mockResolvedValue({});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(8),
				headers: new Headers({ "content-type": "audio/ogg" }),
			}),
		);
		vi.spyOn(TelegramClientService, "isPooled").mockReturnValue(true);
		vi.spyOn(TelegramClientService, "initialize").mockResolvedValue({
			captureSentResult: vi.fn(),
			getClient: () => ({
				getInputEntity: vi.fn().mockResolvedValue(new Api.InputPeerSelf()),
				invoke,
				uploadFile: vi.fn().mockResolvedValue(
					new Api.InputFile({ id: BigInt(1) as never, parts: 1, name: "upload", md5Checksum: "" }),
				),
			}),
		} as unknown as TelegramClientService);

		app = Fastify();
		await new MessageRoute().register(app);
	});

	afterEach(async () => {
		await app.close();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function send(body: Record<string, unknown>) {
		return app.inject({
			method: "POST",
			url: "/messages/SendMessage",
			payload: { sessionId: "session", peer: "456", ...body },
		});
	}

	it("puts each voiceDurations entry on the voice attribute Telegram receives", async () => {
		const response = await send({
			voices: ["https://s3.test/a.oga", "https://s3.test/b.oga"],
			voiceDurations: [7, 1],
		});

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([7, 1]);
	});

	it("sends duration 0 for a caller that posts no voiceDurations", async () => {
		const response = await send({ voices: ["https://s3.test/a.oga"] });

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([0]);
	});

	it("rounds a fractional duration", async () => {
		const response = await send({ voices: ["https://s3.test/a.oga"], voiceDurations: [2.6] });

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([3]);
	});

	it("accepts the int32 maximum", async () => {
		const response = await send({ voices: ["https://s3.test/a.oga"], voiceDurations: [2147483647] });

		expect(response.statusCode).toBe(200);
		expect(sentDurations()).toEqual([2147483647]);
	});

	it.each([
		["a string entry", ["7"]],
		["a null entry", [null]],
		["a negative entry", [-1]],
		["an entry past int32", [2147483648]],
		["a fraction past int32", [2147483647.6]],
		["a non-array", 7],
		["null", null],
	])("rejects %s before sending anything", async (_label, voiceDurations) => {
		const response = await send({
			voices: ["https://s3.test/a.oga", "https://s3.test/b.oga"],
			voiceDurations: Array.isArray(voiceDurations) ? [1, ...voiceDurations] : voiceDurations,
		});

		expect(response.statusCode).toBe(400);
		expect(invoke).not.toHaveBeenCalled();
	});
});
