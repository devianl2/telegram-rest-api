import bigInt from "big-integer";
import Fastify from "fastify";
import { Api } from "teleproto";
import { describe, expect, it, vi } from "vitest";
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
