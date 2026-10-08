import bigInt from "big-integer";
import Fastify from "fastify";
import { Api } from "teleproto";
import { describe, expect, it, vi } from "vitest";
import { ChannelRoute } from "../../src/routes/channels/ChannelRoute";
import { MessageRoute } from "../../src/routes/message/MessageRoute";
import { EventHandler } from "../../src/telegram/EventHandler";

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
