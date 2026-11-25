import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { TelegramUtils } from "../../src/telegram/TelegramUtils";

function makeClient(): TelegramClient {
	return {
		uploadFile: vi.fn().mockResolvedValue(
			new Api.InputFile({
				id: BigInt(1) as never,
				parts: 1,
				name: "upload",
				md5Checksum: "",
			}),
		),
	} as unknown as TelegramClient;
}

describe("TelegramUtils.uploadMedia", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(8),
				headers: new Headers({ "content-type": "audio/ogg" }),
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks voice media with DocumentAttributeAudio(voice) and audio/ogg", async () => {
		const media = await TelegramUtils.uploadMedia(
			makeClient(),
			"https://s3.test/chat/456/abc.oga",
			"voice",
		);

		expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
		const doc = media as Api.InputMediaUploadedDocument;
		expect(doc.mimeType).toBe("audio/ogg");
		expect(doc.attributes).toHaveLength(1);
		const attr = doc.attributes[0] as Api.DocumentAttributeAudio;
		expect(attr).toBeInstanceOf(Api.DocumentAttributeAudio);
		expect(attr.voice).toBe(true);
	});

	it("keeps plain files as documents with a filename attribute", async () => {
		const media = await TelegramUtils.uploadMedia(
			makeClient(),
			"https://s3.test/chat/456/doc.pdf",
			"file",
		);

		expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
		const doc = media as Api.InputMediaUploadedDocument;
		expect(doc.attributes).toHaveLength(1);
		expect(doc.attributes[0]).toBeInstanceOf(Api.DocumentAttributeFilename);
		expect(
			(doc.attributes[0] as Api.DocumentAttributeFilename).fileName,
		).toBe("doc.pdf");
	});
});

describe("TelegramUtils.buildEntities", () => {
	it("maps a blockquote entry to MessageEntityBlockquote", async () => {
		const entities = await TelegramUtils.buildEntities([
			{ type: "blockquote", offset: 3, length: 5 },
		]);

		expect(entities).toHaveLength(1);
		const blockquote = entities![0] as Api.MessageEntityBlockquote;
		expect(blockquote).toBeInstanceOf(Api.MessageEntityBlockquote);
		expect(blockquote.offset).toBe(3);
		expect(blockquote.length).toBe(5);
	});
});

describe("TelegramUtils.pickPhotoSize", () => {
	const real = (type: string, w: number, h: number) =>
		new Api.PhotoSize({ type, w, h, size: w * h });
	// Stripped format: 0x01 marker, then the two header bytes the JPEG template needs.
	const stripped = () =>
		new Api.PhotoStrippedSize({ type: "i", bytes: Buffer.from([1, 40, 37, 0xaa, 0xbb]) });
	const photo = (sizes: Api.TypePhotoSize[]) =>
		new Api.Photo({
			id: bigInt(1),
			accessHash: bigInt(2),
			fileReference: Buffer.from([3]),
			date: 0,
			sizes,
			dcId: 5,
		});

	it("skips the stripped thumbnail Telegram lists last on small photos", () => {
		expect(TelegramUtils.pickPhotoSize(photo([real("m", 85, 79), stripped()]))).toEqual({
			kind: "remote",
			type: "m",
		});
	});

	it("takes the largest real size on large photos", () => {
		const sizes = [stripped(), real("s", 90, 90), real("m", 320, 320), real("x", 800, 800), real("y", 1280, 1280)];
		expect(TelegramUtils.pickPhotoSize(photo(sizes))).toEqual({ kind: "remote", type: "y" });
	});

	it("counts progressive sizes as real", () => {
		const progressive = new Api.PhotoSizeProgressive({ type: "y", w: 1280, h: 960, sizes: [1000, 5000] });
		expect(TelegramUtils.pickPhotoSize(photo([progressive, stripped()]))).toEqual({
			kind: "remote",
			type: "y",
		});
	});

	it("picks by area, not list position", () => {
		const progressive = new Api.PhotoSizeProgressive({ type: "y", w: 1280, h: 960, sizes: [1000, 5000] });
		const sizes = [real("x", 800, 600), stripped(), progressive, real("m", 320, 240)];
		expect(TelegramUtils.pickPhotoSize(photo(sizes))).toEqual({ kind: "remote", type: "y" });
	});

	it("breaks an area tie toward the later element", () => {
		const sizes = [real("a", 400, 300), real("b", 300, 400), real("s", 90, 90)];
		expect(TelegramUtils.pickPhotoSize(photo(sizes))).toEqual({ kind: "remote", type: "b" });
	});

	it("decodes a stripped-only photo into a JPEG", () => {
		const pick = TelegramUtils.pickPhotoSize(photo([stripped()]));

		expect(pick?.kind).toBe("inline");
		const jpeg = (pick as { jpeg: Buffer }).jpeg;
		expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
	});

	it("returns a cached size's bytes as they are", () => {
		const bytes = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
		const cached = new Api.PhotoCachedSize({ type: "c", w: 50, h: 50, bytes });

		expect(TelegramUtils.pickPhotoSize(photo([cached, stripped()]))).toEqual({
			kind: "inline",
			type: "c",
			jpeg: bytes,
		});
	});
});
