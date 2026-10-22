import bigInt from "big-integer";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { Api } from "teleproto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRoute } from "../../src/routes/channels/ChannelRoute";
import { MessageRoute } from "../../src/routes/message/MessageRoute";
import { DatabaseClient } from "../../src/database/DatabaseClient";
import { DeliveryDispatcher } from "../../src/services/DeliveryDispatcher";
import { EventHandler } from "../../src/telegram/EventHandler";
import { S3UploadService } from "../../src/services/S3UploadService";

describe("outgoing Telegram replies", () => {
	it("forwards a text reply target into sent-message reconstruction", async () => {
		const app = Fastify();
		const route = new MessageRoute();
		const routeWithSession = route as unknown as {
			withTelegramSession: (
				sessionId: string,
				operation: (client: unknown) => Promise<unknown>,
			) => Promise<unknown>;
		};
		const captureSentResult = vi.fn().mockResolvedValue(undefined);
		const client = {
			getInputEntity: vi.fn().mockResolvedValue(
				new Api.InputPeerChat({ chatId: bigInt(5409940124) }),
			),
			invoke: vi.fn().mockResolvedValue(
				new Api.UpdateShortSentMessage({
					id: 3599,
					pts: 1,
					ptsCount: 1,
					date: 1785738169,
					out: true,
				}),
			),
		};

		vi.spyOn(routeWithSession, "withTelegramSession").mockImplementation(
			async (_sessionId, operation) =>
				operation({ getClient: () => client, captureSentResult } as never),
		);
		await route.register(app);

		await app.inject({
			method: "POST",
			url: "/messages/SendMessage",
			payload: {
				sessionId: "session-1",
				peer: "5409940124",
				message: "hahaha",
				replyToMsgId: 9152,
			},
		});

		expect(captureSentResult).toHaveBeenCalledWith(
			expect.any(Api.UpdateShortSentMessage),
			expect.objectContaining({ replyToMessageId: 9152 }),
		);
		await app.close();
	});

	it("reconstructs a compact basic-group acknowledgement with a reply header", () => {
		const handler = new EventHandler({} as never, "7920216818", "session-1");
		const updates = (
			handler as unknown as {
				buildSentUpdates: (result: unknown, context: unknown) => Api.TypeUpdate[];
			}
		).buildSentUpdates(
			new Api.UpdateShortSentMessage({
				id: 3599,
				pts: 1,
				ptsCount: 1,
				date: 1785738169,
				out: true,
			}),
			{
				peer: new Api.InputPeerChat({ chatId: bigInt(5409940124) }),
				message: "hahaha",
				replyToMessageId: 9152,
			},
		);

		const message = (updates[0] as Api.UpdateNewMessage).message as Api.Message;
		expect(message.replyTo?.replyToMsgId).toBe(9152);
	});

	it("preserves the reply header supplied by a full supergroup update", () => {
		const handler = new EventHandler({} as never, "7920216818", "session-1");
		const message = new Api.Message({
			id: 3599,
			peerId: new Api.PeerChannel({ channelId: bigInt(5409940124) }),
			message: "hahaha",
			date: 1785738169,
			out: true,
			replyTo: new Api.MessageReplyHeader({ replyToMsgId: 9152 }),
		});
		const update = new Api.UpdateNewChannelMessage({
			message,
			pts: 1,
			ptsCount: 1,
		});
		const updates = (
			handler as unknown as {
				buildSentUpdates: (result: unknown, context: unknown) => Api.TypeUpdate[];
			}
		).buildSentUpdates(
			new Api.Updates({
				updates: [update],
				users: [],
				chats: [],
				date: 1785738169,
				seq: 1,
			}),
			{},
		);

		expect(((updates[0] as Api.UpdateNewChannelMessage).message as Api.Message).replyTo?.replyToMsgId).toBe(9152);
	});
});

/**
 * Telegram never pushes an edit back to the session that made it, so an edit
 * sent through this API only reaches the editor's own channel if the RPC
 * response is captured, the same way a send is.
 */
describe("outgoing Telegram edits", () => {
	function editUpdates(edit: Api.TypeUpdate) {
		return new Api.Updates({ updates: [edit], users: [], chats: [], date: 1785738200, seq: 1 });
	}

	it("captures the EditMessage response for the editing session", async () => {
		const app = Fastify();
		const route = new MessageRoute();
		const routeWithSession = route as unknown as {
			withTelegramSession: (
				sessionId: string,
				operation: (client: unknown) => Promise<unknown>,
			) => Promise<unknown>;
		};
		const captureSentResult = vi.fn().mockResolvedValue(undefined);
		const peer = new Api.InputPeerChat({ chatId: bigInt(5409940124) });
		const response = editUpdates(
			new Api.UpdateEditMessage({
				message: new Api.Message({
					id: 3599,
					peerId: new Api.PeerChat({ chatId: bigInt(5409940124) }),
					message: "edited",
					date: 1785738169,
					editDate: 1785738200,
					out: true,
				}),
				pts: 1,
				ptsCount: 1,
			}),
		);
		const client = {
			getInputEntity: vi.fn().mockResolvedValue(peer),
			invoke: vi.fn().mockResolvedValue(response),
		};

		vi.spyOn(routeWithSession, "withTelegramSession").mockImplementation(
			async (_sessionId, operation) =>
				operation({ getClient: () => client, captureSentResult } as never),
		);
		await route.register(app);

		await app.inject({
			method: "POST",
			url: "/messages/EditMessage",
			payload: { sessionId: "session-1", peer: "5409940124", id: 3599, message: "edited" },
		});

		expect(captureSentResult).toHaveBeenCalledWith(response, { peer });
		await app.close();
	});

	it.each([
		["basic group", (message: Api.Message) => new Api.UpdateEditMessage({ message, pts: 1, ptsCount: 1 })],
		["supergroup", (message: Api.Message) => new Api.UpdateEditChannelMessage({ message, pts: 1, ptsCount: 1 })],
	])("keeps the %s edit update from the response", (_label, buildEdit) => {
		const handler = new EventHandler({} as never, "7920216818", "session-1");
		const edit = buildEdit(
			new Api.Message({
				id: 3599,
				peerId: new Api.PeerChat({ chatId: bigInt(5409940124) }),
				message: "edited",
				date: 1785738169,
				editDate: 1785738200,
				out: true,
			}),
		);

		const updates = (
			handler as unknown as {
				buildSentUpdates: (result: unknown, context: unknown) => Api.TypeUpdate[];
			}
		).buildSentUpdates(editUpdates(edit), {});

		expect(updates).toEqual([edit]);
	});
});

/**
 * Telegram never pushes a delete back to the session that made it, and the
 * delete RPCs return only AffectedMessages, so the delete update is rebuilt
 * from the request ids.
 */
describe("outgoing Telegram deletes", () => {
	const affected = new Api.messages.AffectedMessages({ pts: 10, ptsCount: 1 });

	function mockSession(route: unknown, client: unknown, captureSentResult: unknown) {
		const routeWithSession = route as {
			withTelegramSession: (
				sessionId: string,
				operation: (client: unknown) => Promise<unknown>,
			) => Promise<unknown>;
		};
		vi.spyOn(routeWithSession, "withTelegramSession").mockImplementation(
			async (_sessionId, operation) =>
				operation({ getClient: () => client, captureSentResult } as never),
		);
	}

	it("captures the messages.DeleteMessages response with the deleted ids", async () => {
		const app = Fastify();
		const route = new MessageRoute();
		const captureSentResult = vi.fn().mockResolvedValue(undefined);
		mockSession(route, { invoke: vi.fn().mockResolvedValue(affected) }, captureSentResult);
		await route.register(app);

		await app.inject({
			method: "POST",
			url: "/messages/DeleteMessages",
			payload: { sessionId: "session-1", id: ["9465"], revoke: true },
		});

		expect(captureSentResult).toHaveBeenCalledWith(affected, { peer: undefined, deletedIds: [9465] });
		await app.close();
	});

	it("captures the channels.DeleteMessages response with the channel peer", async () => {
		const app = Fastify();
		const route = new ChannelRoute();
		const captureSentResult = vi.fn().mockResolvedValue(undefined);
		mockSession(route, { invoke: vi.fn().mockResolvedValue(affected) }, captureSentResult);
		await route.register(app);

		await app.inject({
			method: "POST",
			url: "/channels/DeleteMessages",
			payload: { sessionId: "session-1", channelId: "1234567890", accessHash: "42", id: [9465] },
		});

		const [, context] = captureSentResult.mock.calls[0];
		expect(captureSentResult.mock.calls[0][0]).toBe(affected);
		expect(context.deletedIds).toEqual([9465]);
		expect(context.peer).toBeInstanceOf(Api.InputChannel);
		await app.close();
	});

	function build(context: unknown) {
		const handler = new EventHandler({} as never, "7920216818", "session-1");
		return (
			handler as unknown as {
				buildSentUpdates: (result: unknown, context: unknown) => Api.TypeUpdate[];
			}
		).buildSentUpdates(affected, context);
	}

	it("rebuilds UpdateDeleteMessages for a private chat or basic group", () => {
		const [update] = build({ peer: undefined, deletedIds: [9465] }) as Api.UpdateDeleteMessages[];

		expect(update).toBeInstanceOf(Api.UpdateDeleteMessages);
		expect(update.messages).toEqual([9465]);
	});

	it("rebuilds UpdateDeleteChannelMessages for a supergroup or channel", () => {
		const peer = new Api.InputChannel({ channelId: bigInt(1234567890), accessHash: bigInt(42) });
		const [update] = build({ peer, deletedIds: [9465] }) as Api.UpdateDeleteChannelMessages[];

		expect(update).toBeInstanceOf(Api.UpdateDeleteChannelMessages);
		expect(update.channelId.toString()).toBe("1234567890");
		expect(update.messages).toEqual([9465]);
	});
});

describe("forwarded update payload", () => {
	function stubPersistence() {
		const inserted: { raw_payload: string }[] = [];
		const d = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: () => [{ id: 7n, telegram_user_id: "7920216818" }],
					}),
				}),
			}),
			insert: () => ({
				values: (row: { raw_payload: string }) => {
					inserted.push(row);
				},
			}),
		};
		vi.spyOn(DatabaseClient, "getInstance").mockReturnValue({
			execute: async (fn: (db: unknown) => unknown) => fn(d),
		} as never);
		vi.spyOn(DeliveryDispatcher, "wake").mockImplementation(() => undefined);
		return inserted;
	}

	const sessionString =
		"1BQANOTEuMTA4LjU2LjE1MgG7Ae4qk2Xr0vYwF9pLz3mHcQ8sJtNbKdWuVyEaRgTiOhPnMfCxZlBj5o7D1e6S2r4U0w9q8YkAv3hGxLsNpQmIcRtJbFuWyEzKdVa" +
		"Hg2Oi4Pn6Mf8Cx0Zl1Bj3o5D7e9S1r3U5w7q9YkAv1hGxLsNpQmIcRtJbFuWyEzKdVaHg2Oi4Pn6Mf8Cx0Zl1Bj3o5D7e9S1r3U5w7q9Yk=";
	const sessionHash = createHash("sha256").update(sessionString, "utf8").digest("hex");

	afterEach(() => vi.restoreAllMocks());

	it("stamps the receiving session hash on a realtime update", async () => {
		const inserted = stubPersistence();
		const handler = new EventHandler({} as never, "7920216818", sessionString);

		(handler as unknown as { handleRawUpdate: (u: Api.TypeUpdate) => void }).handleRawUpdate(
			new Api.UpdateDeleteMessages({ messages: [9465], pts: 1, ptsCount: 1 }),
		);

		await vi.waitFor(() => expect(inserted).toHaveLength(1));
		const payload = JSON.parse(inserted[0].raw_payload);
		expect(payload.sessionHash).toBe(sessionHash);
		expect(payload).not.toHaveProperty("sessionId");
		expect(inserted[0].raw_payload).not.toContain(sessionString);
		expect(payload.receiverId).toEqual({ userId: "7920216818", className: "PeerUser" });
	});

	it("stamps the sending session hash on a captured sent message", async () => {
		const inserted = stubPersistence();
		const handler = new EventHandler({} as never, "7920216818", sessionString);

		await handler.captureSentResult(
			new Api.UpdateShortSentMessage({ id: 3599, pts: 1, ptsCount: 1, date: 1785738169, out: true }),
			{ peer: new Api.InputPeerChat({ chatId: bigInt(5409940124) }), message: "hi" },
		);

		expect(inserted).toHaveLength(1);
		expect(JSON.parse(inserted[0].raw_payload).sessionHash).toBe(sessionHash);
		expect(inserted[0].raw_payload).not.toContain(sessionString);
	});
});

/**
 * A small photo lists [m, stripped i]; getFile with the trailing "i" fails, so
 * ingest and DownloadAttachments must both ask for "m".
 */
describe("small photo download", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const smallPhoto = () =>
		new Api.Photo({
			id: bigInt(6170),
			accessHash: bigInt(42),
			fileReference: Buffer.from([7]),
			date: 1785738169,
			sizes: [
				new Api.PhotoSize({ type: "m", w: 85, h: 79, size: 2883 }),
				new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 40, 37, 0xaa]) }),
			],
			dcId: 5,
		});
	const photoMessage = (photo: Api.Photo) =>
		new Api.Message({
			id: 9200,
			peerId: new Api.PeerUser({ userId: bigInt(5409940124) }),
			message: "",
			date: 1785738169,
			media: new Api.MessageMediaPhoto({ photo }),
		});

	type HandlerInternals = {
		extractMediaFromUpdate: (update: unknown, all: boolean) => Array<{ rawInputJson: string }>;
		downloadFile: (rawInput: unknown) => Promise<Buffer>;
	};

	it("ingests the real size and downloads it with that thumbSize", async () => {
		const client = { downloadFile: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])) };
		const handler = new EventHandler(client as never, "7920216818", "session-1") as unknown as HandlerInternals;
		const update = new Api.UpdateNewMessage({ message: photoMessage(smallPhoto()), pts: 1, ptsCount: 1 });

		const [media] = handler.extractMediaFromUpdate(update, false);
		const rawInput = JSON.parse(media.rawInputJson);
		await handler.downloadFile(rawInput);

		expect(rawInput.thumbSize).toBe("m");
		expect(rawInput.inlineJpegBase64).toBeUndefined();
		const [location] = client.downloadFile.mock.calls[0];
		expect(location).toBeInstanceOf(Api.InputPhotoFileLocation);
		expect(location.thumbSize).toBe("m");
	});

	it("serves an inline-only photo from rawInput without calling Telegram", async () => {
		const client = { downloadFile: vi.fn() };
		const handler = new EventHandler(client as never, "7920216818", "session-1") as unknown as HandlerInternals;
		const photo = smallPhoto();
		photo.sizes = [photo.sizes[1]];
		const update = new Api.UpdateNewMessage({ message: photoMessage(photo), pts: 1, ptsCount: 1 });

		const [media] = handler.extractMediaFromUpdate(update, false);
		const buffer = await handler.downloadFile(JSON.parse(media.rawInputJson));

		expect(client.downloadFile).not.toHaveBeenCalled();
		expect([...buffer.subarray(0, 2)]).toEqual([0xff, 0xd8]);
	});

	async function downloadAttachments(downloadFile: ReturnType<typeof vi.fn>) {
		const app = Fastify();
		const route = new MessageRoute();
		const routeWithSession = route as unknown as {
			withTelegramSession: (
				sessionId: string,
				operation: (client: unknown) => Promise<unknown>,
			) => Promise<unknown>;
		};
		const client = {
			getInputEntity: vi.fn().mockResolvedValue(new Api.InputPeerUser({ userId: bigInt(5409940124), accessHash: bigInt(1) })),
			invoke: vi.fn().mockResolvedValue(
				new Api.messages.Messages({ messages: [photoMessage(smallPhoto())], chats: [], users: [], topics: [] }),
			),
			downloadFile,
		};
		vi.spyOn(routeWithSession, "withTelegramSession").mockImplementation(
			async (_sessionId, operation) => operation({ getClient: () => client } as never),
		);
		vi.spyOn(S3UploadService, "isConfigured").mockReturnValue(true);
		vi.spyOn(S3UploadService, "exists").mockResolvedValue(null);
		const upload = vi.spyOn(S3UploadService, "upload").mockResolvedValue("https://s3.test/photo.jpg");
		await route.register(app);

		const response = await app.inject({
			method: "POST",
			url: "/messages/DownloadAttachments",
			payload: { sessionId: "session-1", peer: "5409940124", messageIds: [9200] },
		});
		await app.close();
		return { response, upload };
	}

	it("DownloadAttachments fetches the real size", async () => {
		const downloadFile = vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8]));

		const { response, upload } = await downloadAttachments(downloadFile);

		expect(response.statusCode).toBe(200);
		expect(downloadFile.mock.calls[0][0].thumbSize).toBe("m");
		expect(upload).toHaveBeenCalledOnce();
	});

	it("DownloadAttachments reports the thumbSize it tried and keeps the Telegram code", async () => {
		const rpcError = Object.assign(new Error("FILE_REFERENCE_EXPIRED"), { code: 400 });
		const downloadFile = vi.fn().mockRejectedValue(rpcError);

		const { response } = await downloadAttachments(downloadFile);

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("photo 6170 thumbSize m: FILE_REFERENCE_EXPIRED");
	});
});
