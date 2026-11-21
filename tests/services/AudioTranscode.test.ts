import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { toBrowserPlayableAudio } from "../../src/services/AudioTranscode";

function hasFfmpeg(): boolean {
	try {
		execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** One second of sine wave encoded with `codec` in `format`, made by ffmpeg itself. */
function sample(codec: string, format: string): Buffer {
	return execFileSync(
		"ffmpeg",
		["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", "-ac", "2", "-c:a", codec, "-f", format, "pipe:1"],
		{ maxBuffer: 10 * 1024 * 1024 },
	);
}

function codecOf(buffer: Buffer): string {
	return execFileSync(
		"ffprobe",
		["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", "pipe:0"],
		{ input: buffer },
	)
		.toString()
		.trim();
}

describe.skipIf(!hasFfmpeg())("toBrowserPlayableAudio", () => {
	it.each([
		["eac3", "eac3"],
		["ac3", "ac3"],
	])("re-encodes %s (in %s) to AAC", async (codec, format) => {
		const out = await toBrowserPlayableAudio(sample(codec, format));
		expect(out).not.toBeNull();
		expect(codecOf(out!)).toBe("aac");
	});

	it.each([
		["aac", "adts"],
		["libopus", "ogg"],
	])("leaves %s (in %s) alone", async (codec, format) => {
		expect(await toBrowserPlayableAudio(sample(codec, format))).toBeNull();
	});

	it("returns null for bytes that are not audio", async () => {
		expect(await toBrowserPlayableAudio(Buffer.from("not audio"))).toBeNull();
	});
});
