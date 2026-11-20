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

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DatabaseClient } from "../../src/database/DatabaseClient";
import { SessionCallbackService } from "../../src/services/SessionCallbackService";
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

describe("TelegramClientService.invalidate", () => {
	afterEach(() => {
		vi.useRealTimers();
		databaseCalls = 0;
		(TelegramClientService as any).pool.clear();
	});

	it("finishes when the logout never answers", async () => {
		vi.useFakeTimers();
		const destroy = vi.fn().mockResolvedValue(undefined);
		(TelegramClientService as any).pool.set("session-1", {
			getClient: () => ({ invoke: () => new Promise(() => {}) }),
			destroy,
		});
		const finished = vi.fn();

		void TelegramClientService.invalidate(
			"session-1",
			"receiving_updates_stalled",
		).then(finished);
		await vi.advanceTimersByTimeAsync(9_000);
		expect(finished).not.toHaveBeenCalled();
		expect(destroy).not.toHaveBeenCalled();
		expect(TelegramClientService.isPooled("session-1")).toBe(false);

		await vi.advanceTimersByTimeAsync(2_000);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(finished).toHaveBeenCalledWith(true);
		expect(TelegramClientService.isPooled("session-1")).toBe(false);
	});

	it("logs one line when the logout is not confirmed", async () => {
		vi.useFakeTimers();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		(TelegramClientService as any).pool.set("session-1", {
			getClient: () => ({ invoke: () => new Promise(() => {}) }),
			destroy: vi.fn().mockResolvedValue(undefined),
		});
		const finished = vi.fn();

		void TelegramClientService.invalidate(
			"session-1",
			"receiving_updates_stalled",
		).then(finished);
		await vi.advanceTimersByTimeAsync(11_000);

		expect(finished).toHaveBeenCalledWith(true);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			"[Session] Logout not confirmed for user 42: logout timed out",
		);
		warnSpy.mockRestore();
	});

	it("finishes when the client never finishes closing", async () => {
		const destroy = vi.fn().mockReturnValue(new Promise(() => {}));
		(TelegramClientService as any).pool.set("session-1", {
			getClient: () => ({ invoke: vi.fn().mockResolvedValue(true) }),
			destroy,
		});

		await expect(
			TelegramClientService.invalidate("session-1", "unauthorized"),
		).resolves.toBe(true);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(TelegramClientService.isPooled("session-1")).toBe(false);
	});

	it("logs one line when closing the client fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		(TelegramClientService as any).pool.set("session-1", {
			getClient: () => ({ invoke: vi.fn().mockResolvedValue(true) }),
			destroy: vi.fn().mockRejectedValue(new Error("socket gone")),
		});

		await TelegramClientService.invalidate("session-1", "unauthorized");
		await Promise.resolve();

		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"[Session] Closing client failed for user 42: socket gone",
		);
		errorSpy.mockRestore();
	});

	it("tells Chat-X the session was removed with the reason it was given", async () => {
		await TelegramClientService.invalidate("session-1", "logout");

		expect(SessionCallbackService.notify).toHaveBeenCalledWith(
			"https://example.com/callback",
			"telegram_session_removed",
			"session-1",
			"42",
			"removed",
			"logout",
		);
	});

	it("logs out and destroys a client that answers", async () => {
		const destroy = vi.fn().mockResolvedValue(undefined);
		const invoke = vi.fn().mockResolvedValue(true);
		(TelegramClientService as any).pool.set("session-1", {
			getClient: () => ({ invoke }),
			destroy,
		});

		await expect(
			TelegramClientService.invalidate("session-1", "unauthorized"),
		).resolves.toBe(true);

		expect(invoke).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledTimes(1);
	});
});

describe("TelegramClientService.findSessionRecord", () => {
	const originalServerName = process.env.SERVER_NAME;

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalServerName === undefined) delete process.env.SERVER_NAME;
		else process.env.SERVER_NAME = originalServerName;
	});

	it("looks the session up only among the rows of this server", async () => {
		process.env.SERVER_NAME = "server-a";
		let condition: SQL | undefined;
		let rowLimit: number | undefined;
		const queryBuilder = {
			select: () => queryBuilder,
			from: () => queryBuilder,
			where: (whereCondition: SQL) => {
				condition = whereCondition;
				return queryBuilder;
			},
			limit: (limitCount: number) => {
				rowLimit = limitCount;
				return Promise.resolve([]);
			},
		};
		vi.spyOn(DatabaseClient, "getInstance").mockReturnValue({
			execute: (operation: (database: unknown) => unknown) => operation(queryBuilder),
		} as unknown as DatabaseClient);

		await TelegramClientService.findSessionRecord("session-1");

		const query = new PgDialect().sqlToQuery(condition!);
		expect(query.sql).toContain('"session_id" = $1');
		expect(query.sql).toContain('"server_name" = $2');
		expect(query.params).toEqual(["session-1", "server-a"]);
		expect(rowLimit).toBe(1);
	});
});
