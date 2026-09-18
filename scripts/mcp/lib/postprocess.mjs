import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Finds an ffmpeg binary: RECORDLY_FFMPEG, the copy bundled with the installed
 * Recordly (ffmpeg-static under app.asar.unpacked), the repo's node_modules,
 * or `ffmpeg` on PATH.
 */
export async function resolveFfmpegPath({
	env = process.env,
	execPath = process.execPath,
	scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
	platform = process.platform,
	exists = async (candidate) => {
		try {
			await fs.access(candidate);
			return true;
		} catch {
			return false;
		}
	},
} = {}) {
	const exe = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const candidates = [];
	if (env.RECORDLY_FFMPEG) {
		candidates.push(env.RECORDLY_FFMPEG);
	}
	// Installed app: <app>/resources/mcp/lib → <app>/resources/app.asar.unpacked/node_modules/ffmpeg-static
	candidates.push(
		path.join(scriptDir, "..", "..", "app.asar.unpacked", "node_modules", "ffmpeg-static", exe),
	);
	candidates.push(
		path.join(
			path.dirname(execPath),
			"resources",
			"app.asar.unpacked",
			"node_modules",
			"ffmpeg-static",
			exe,
		),
	);
	// Repository checkout: scripts/mcp/lib → node_modules/ffmpeg-static
	candidates.push(path.join(scriptDir, "..", "..", "..", "node_modules", "ffmpeg-static", exe));
	for (const candidate of candidates) {
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return "ffmpeg";
}

/**
 * Builds the ffmpeg arguments that turn a raw window recording into a
 * deliverable clip: optionally crop the OS title bar, then letterbox into the
 * requested frame (default 1280x720, like the reference sample) at a fixed fps.
 */
export function buildFitArgs(inputPath, outputPath, fit = {}) {
	const width = Number.isFinite(fit.width) ? Math.max(16, Math.round(fit.width)) : 1280;
	const height = Number.isFinite(fit.height) ? Math.max(16, Math.round(fit.height)) : 720;
	const fps = Number.isFinite(fit.fps) ? Math.max(1, Math.min(60, Math.round(fit.fps))) : 30;
	const cropTop = Number.isFinite(fit.cropTop) ? Math.max(0, Math.round(fit.cropTop)) : 0;
	const cropBottom = Number.isFinite(fit.cropBottom)
		? Math.max(0, Math.round(fit.cropBottom))
		: 0;
	const background =
		typeof fit.background === "string" && fit.background ? fit.background : "black";
	const filters = [];
	if (cropTop > 0 || cropBottom > 0) {
		filters.push(`crop=iw:ih-${cropTop + cropBottom}:0:${cropTop}`);
	}
	filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
	filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${background}`);
	filters.push("format=yuv420p");
	const audio = fit.keepAudio === true ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"];
	return [
		"-y",
		"-v",
		"error",
		"-i",
		inputPath,
		"-vf",
		filters.join(","),
		"-r",
		String(fps),
		"-c:v",
		"libx264",
		"-preset",
		"medium",
		"-crf",
		"20",
		...audio,
		"-movflags",
		"+faststart",
		outputPath,
	];
}

export async function fitRecording(
	inputPath,
	outputPath,
	fit = {},
	{ ffmpegPath, exec = execFileAsync } = {},
) {
	const ffmpeg = ffmpegPath ?? (await resolveFfmpegPath());
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const args = buildFitArgs(inputPath, outputPath, fit);
	try {
		await exec(ffmpeg, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
	} catch (error) {
		const detail = error?.stderr?.toString?.().trim() || error?.message || String(error);
		throw new Error(`ffmpeg failed (${ffmpeg}): ${detail}`);
	}
	return { outputPath, ffmpeg, args };
}
