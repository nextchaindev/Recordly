import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTool, TOOL_DEFINITIONS } from "./tools.mjs";

function createFakeClient(responses = {}) {
	const calls = [];
	return {
		calls,
		async call(method, params = {}) {
			calls.push({ method, params });
			const responder = responses[method];
			if (typeof responder === "function") {
				return responder(params);
			}
			if (responder instanceof Error) {
				throw responder;
			}
			return responder ?? { ok: true };
		},
	};
}

describe("TOOL_DEFINITIONS", () => {
	it("declares unique, prefixed tool names with object schemas", () => {
		const names = TOOL_DEFINITIONS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
		for (const tool of TOOL_DEFINITIONS) {
			expect(tool.name.startsWith("recordly_")).toBe(true);
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.inputSchema.type).toBe("object");
		}
	});
});

describe("runTool", () => {
	let tempDir;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-tools-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("selects a source, applies preferences and shows the HUD before starting", async () => {
		const client = createFakeClient({
			"sources.select": { selected: { id: "window:1:0", name: "Cursor" } },
			"recording.preferences": { microphoneEnabled: false },
			"recording.start": { started: true },
		});
		const result = await runTool(client, "recordly_start_recording", {
			source: { name: "Cursor", type: "window" },
			microphoneEnabled: false,
			countdownSeconds: 0,
		});
		expect(client.calls.map((call) => call.method)).toEqual([
			"sources.select",
			"recording.preferences",
			"hud.show",
			"recording.start",
		]);
		expect(client.calls[1].params).toEqual({ microphoneEnabled: false, countdownSeconds: 0 });
		expect(JSON.parse(result.content[0].text).recording).toEqual({ started: true });
	});

	it("copies the finished recording to saveAs", async () => {
		const recorded = path.join(tempDir, "recording-1.mp4");
		await fs.writeFile(recorded, "video-bytes");
		const client = createFakeClient({
			"recording.stop": { stopped: true, videoPath: recorded, webcamPath: null },
		});
		const destination = path.join(tempDir, "AI캡처", "cursor", "90_recording_agent_flow.mp4");
		const result = await runTool(client, "recordly_stop_recording", { saveAs: destination });
		const payload = JSON.parse(result.content[0].text);
		expect(payload.savedAs).toBe(path.resolve(destination));
		expect(await fs.readFile(destination, "utf-8")).toBe("video-bytes");
		expect(client.calls[0].params).toEqual({ waitForFile: true, timeoutMs: undefined });
	});

	it("returns screenshots inline only when requested", async () => {
		const client = createFakeClient({
			"screen.capture": (params) => ({
				outputPath: "C:/shots/a.png",
				width: 10,
				height: 10,
				...(params.base64 ? { base64: "AAAA", mimeType: "image/png" } : {}),
			}),
		});
		const plain = await runTool(client, "recordly_capture_screenshot", { name: "Cursor" });
		expect(plain.content).toHaveLength(1);
		expect(client.calls[0].params).toEqual({ name: "Cursor", base64: false });

		const inline = await runTool(client, "recordly_capture_screenshot", {
			name: "Cursor",
			returnImage: true,
		});
		expect(inline.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
		expect(inline.content[0].text).not.toContain("AAAA");
	});

	it("captures Recordly windows inline by default", async () => {
		const client = createFakeClient({
			"windows.capture": { outputPath: "x.png", base64: "BBBB", mimeType: "image/png" },
		});
		const result = await runTool(client, "recordly_capture_window", { window: "hud-overlay" });
		expect(client.calls[0].params).toEqual({ window: "hud-overlay", base64: true });
		expect(result.content[1].type).toBe("image");
	});

	it("skips launching when the app already answers ping", async () => {
		const client = createFakeClient({ ping: { ok: true } });
		let launched = false;
		const result = await runTool(
			client,
			"recordly_launch",
			{},
			{
				launch: async () => {
					launched = true;
				},
			},
		);
		expect(launched).toBe(false);
		expect(JSON.parse(result.content[0].text).launched).toBe(false);
	});

	it("launches when the app is unreachable", async () => {
		const client = createFakeClient({ ping: new Error("ECONNREFUSED") });
		const result = await runTool(
			client,
			"recordly_launch",
			{ appPath: "C:/Recordly.exe" },
			{ launch: async ({ appPath }) => ({ pid: 7, info: { port: 5000, appPath } }) },
		);
		expect(JSON.parse(result.content[0].text)).toEqual({ launched: true, pid: 7, port: 5000 });
	});

	it("rejects unknown tools", async () => {
		await expect(runTool(createFakeClient(), "recordly_nope", {})).rejects.toThrow(
			/Unknown tool/,
		);
	});
});
