import { afterEach, describe, expect, it, vi } from "vitest";

const startedHandlers: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];

vi.mock("../../src/telegram/EventHandler", () => ({
	EventHandler: class {
		start = vi.fn().mockResolvedValue(undefined);
		stop = vi.fn();
		constructor() {
			startedHandlers.push(this);
		}
	},
}));

let databaseCalls = 0;

vi.mock("../../src/database/DatabaseClient", () => ({
	DatabaseClient: {
		getInstance: () => ({
			execute: () => {
				databaseCalls += 1;
				return Promise.resolve(
					databaseCalls === 1
						? [{ callback_url: "https://example.com/callback", telegram_user_id: "42" }]
						: { rowCount: 1 },
				);
			},
		}),
	},
}));

vi.mock("../../src/services/SessionCallbackService", () => ({
	SessionCallbackService: { notify: vi.fn().mockResolvedValue(true) },
}));

import { TelegramClientService } from "../../src/telegram/TelegramClientService";

describe("TelegramClientService event handler", () => {
	afterEach(() => {
		startedHandlers.length = 0;
		(TelegramClientService as any).eventHandlers.clear();
	});

	it("keeps one handler after the same session is saved twice", () => {
		const client = { getClient: () => ({}) };

		(TelegramClientService as any).startEventHandler("session-1", client, "42");
		(TelegramClientService as any).startEventHandler("session-1", client, "42");

		expect(startedHandlers).toHaveLength(2);
		expect(startedHandlers[0].stop).toHaveBeenCalledTimes(1);
		expect(startedHandlers[1].stop).not.toHaveBeenCalled();
		expect((TelegramClientService as any).eventHandlers.get("session-1")).toBe(
			startedHandlers[1],
		);
	});
});
