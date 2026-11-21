import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 45_000;
const MAX_BUFFER = 1024 * 1024;

/** Audio codecs Chrome, Firefox and Safari all decode; anything else is re-encoded to AAC. */
const BROWSER_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

function isBrowserPlayable(codec: string): boolean {
	return BROWSER_CODECS.has(codec) || codec.startsWith("pcm_");
}

/**
 * Returns the audio re-encoded as stereo AAC in MP4 when its codec is one
 * browsers can't decode (E-AC-3, AC-3, ALAC, WMA, AMR…), else null. Also null
 * when ffmpeg is missing or fails: the caller then stores the original file,
 * so a conversion problem never loses the attachment.
 */
export async function toBrowserPlayableAudio(buffer: Buffer): Promise<Buffer | null> {
	const dir = await mkdtemp(join(tmpdir(), "audio-"));
	const input = join(dir, "in");
	const output = join(dir, "out.m4a");
	try {
		await writeFile(input, buffer);
		const { stdout } = await run(
			"ffprobe",
			["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", input],
			{ timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
		);
		// Side data (e.g. on E-AC-3) adds an empty CSV field: "eac3,". Keep only the codec name.
		const codec = /^[a-z0-9_]+/.exec(stdout.trim())?.[0] ?? "";
		if (!codec || isBrowserPlayable(codec)) return null;

		await run(
			"ffmpeg",
			["-v", "error", "-i", input, "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
				"-movflags", "+faststart", "-f", "mp4", output],
			{ timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
		);
		const converted = await readFile(output);
		console.info(`[audio-transcode] ${codec} -> aac (${buffer.length} -> ${converted.length} bytes)`);
		return converted;
	} catch (error) {
		console.warn(
			`[audio-transcode] kept the original file: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
