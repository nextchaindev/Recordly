import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFitArgs, fitRecording, resolveFfmpegPath } from "./postprocess.mjs";

describe("buildFitArgs", () => {
	it("defaults to a 1280x720 letterboxed 30fps clip without audio", () => {
		const args = buildFitArgs("in.mp4", "out.mp4");
		const vf = args[args.indexOf("-vf") + 1];
		expect(vf).toBe(
			"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p",
		);
		expect(args).toContain("-an");
		expect(args[args.indexOf("-r") + 1]).toBe("30");
		expect(args.at(-1)).toBe("out.mp4");
	});

	it("crops the title bar and keeps audio when asked", () => {
		const args = buildFitArgs("in.mp4", "out.mp4", {
			width: 1920,
			height: 1080,
			cropTop: 40,
			cropBottom: 8,
			fps: 60,
			background: "white",
			keepAudio: true,
		});
		const vf = args[args.indexOf("-vf") + 1];
		expect(vf.startsWith("crop=iw:ih-48:0:40,scale=1920:1080")).toBe(true);
		expect(vf).toContain(":white,format=yuv420p");
		expect(args).toContain("aac");
		expect(args[args.indexOf("-r") + 1]).toBe("60");
	});
});

describe("resolveFfmpegPath", () => {
	it("prefers RECORDLY_FFMPEG, then the bundled binary, then PATH", async () => {
		expect(
			await resolveFfmpegPath({
				env: { RECORDLY_FFMPEG: "D:/tools/ffmpeg.exe" },
				exists: async (candidate) => candidate === "D:/tools/ffmpeg.exe",
			}),
		).toBe("D:/tools/ffmpeg.exe");

		const bundled = path.join(
			"C:/Program Files/Recordly/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe",
		);
		expect(
			await resolveFfmpegPath({
				env: {},
				platform: "win32",
				scriptDir: "C:/Program Files/Recordly/resources/mcp/lib",
				execPath: "C:/Program Files/Recordly/Recordly.exe",
				exists: async (candidate) => path.normalize(candidate) === path.normalize(bundled),
			}),
		).toBe(
			path.join(
				"C:/Program Files/Recordly/resources/mcp/lib",
				"..",
				"..",
				"app.asar.unpacked",
				"node_modules",
				"ffmpeg-static",
				"ffmpeg.exe",
			),
		);

		expect(await resolveFfmpegPath({ env: {}, exists: async () => false })).toBe("ffmpeg");
	});
});

describe("fitRecording", () => {
	it("invokes ffmpeg with the built arguments", async () => {
		const calls = [];
		const result = await fitRecording(
			"in.mp4",
			path.join(process.cwd(), "out.mp4"),
			{ cropTop: 40 },
			{
				ffmpegPath: "ffmpeg",
				exec: async (command, args) => {
					calls.push({ command, args });
					return { stdout: "", stderr: "" };
				},
			},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("ffmpeg");
		expect(calls[0].args).toContain("-vf");
		expect(result.outputPath.endsWith("out.mp4")).toBe(true);
	});

	it("surfaces ffmpeg stderr on failure", async () => {
		await expect(
			fitRecording(
				"in.mp4",
				path.join(process.cwd(), "out.mp4"),
				{},
				{
					ffmpegPath: "ffmpeg",
					exec: async () => {
						const error = new Error("exit 1");
						error.stderr = "Unknown encoder 'libx264'";
						throw error;
					},
				},
			),
		).rejects.toThrow(/Unknown encoder/);
	});
});
