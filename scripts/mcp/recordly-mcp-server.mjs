#!/usr/bin/env node
/**
 * Recordly MCP server (stdio).
 *
 * Lets an AI agent (Claude Code, Cursor, Codex, ...) drive Recordly directly:
 * pick a window to record, start/stop recordings, take clean screenshots of a
 * single window or display, and inspect/click Recordly's own UI, which is
 * normally hidden from screen capture.
 *
 * No dependencies: run with `node scripts/mcp/recordly-mcp-server.mjs`.
 * Recordly must be running with the control server enabled
 * (RECORDLY_CONTROL_SERVER=1 or --control-server), or set RECORDLY_APP_PATH
 * and call the recordly_launch tool.
 */
import { createRequire } from "node:module";
import { launchRecordly, RecordlyControlClient } from "./lib/controlClient.mjs";
import {
	createDispatcher,
	JSONRPC_INVALID_PARAMS,
	JsonRpcError,
	serializeMessage,
	splitLines,
} from "./lib/jsonrpc.mjs";
import { runTool, TOOL_DEFINITIONS } from "./lib/tools.mjs";

const require = createRequire(import.meta.url);

function resolveServerVersion() {
	// In the repo the script sits under scripts/mcp; in the packaged app it is
	// copied to resources/mcp without a package.json next to it.
	// Repo: scripts/mcp → ../../package.json. Extension bundle: server/ → ../package.json.
	// Installed app: resources/mcp → ../app.asar/package.json.
	for (const candidate of ["../../package.json", "../package.json", "../app.asar/package.json"]) {
		try {
			return require(candidate).version ?? "0.0.0";
		} catch {
			// Try the next location.
		}
	}
	return "0.0.0";
}

const packageJson = { version: resolveServerVersion() };

const client = new RecordlyControlClient();
let toolQueue = Promise.resolve();

const dispatch = createDispatcher({
	initialize: () => ({
		protocolVersion: "2025-06-18",
		capabilities: { tools: { listChanged: false } },
		serverInfo: { name: "recordly", version: packageJson.version },
		instructions:
			"Recordly screen recorder control. Typical flow: recordly_status → recordly_list_sources → " +
			"recordly_select_source (a window title records only that window) → recordly_start_recording → " +
			"do the on-screen actions with your other tools → recordly_stop_recording (saveAs=...). " +
			"Use recordly_capture_screenshot for still images of a window or display, and " +
			"recordly_capture_window / recordly_ui_snapshot to see Recordly's own UI.",
	}),
	"notifications/initialized": () => null,
	"notifications/cancelled": () => null,
	ping: () => ({}),
	"tools/list": () => ({ tools: TOOL_DEFINITIONS }),
	"tools/call": (params) => {
		const name = params?.name;
		if (typeof name !== "string") {
			throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'tools/call requires a string "name".');
		}
		// Tool calls mutate app state (launch → select → record), so run them
		// one at a time even if a client pipelines requests.
		const run = toolQueue.then(async () => {
			try {
				return await runTool(client, name, params.arguments ?? {}, {
					launch: launchRecordly,
				});
			} catch (error) {
				if (error instanceof JsonRpcError) {
					throw error;
				}
				return {
					isError: true,
					content: [{ type: "text", text: error?.message ?? String(error) }],
				};
			}
		});
		toolQueue = run.catch(() => undefined);
		return run;
	},
	"resources/list": () => ({ resources: [] }),
	"prompts/list": () => ({ prompts: [] }),
});

let buffer = "";
let writeChain = Promise.resolve();

function write(message) {
	if (!message) return;
	writeChain = writeChain.then(
		() =>
			new Promise((resolve) => {
				process.stdout.write(serializeMessage(message), () => resolve());
			}),
	);
}

const inFlight = new Set();

function handleLine(line) {
	const task = dispatch(line)
		.then(write, (error) => {
			console.error("[recordly-mcp] dispatch failure:", error);
		})
		.finally(() => inFlight.delete(task));
	inFlight.add(task);
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
	const { lines, rest } = splitLines(buffer, chunk);
	buffer = rest;
	for (const line of lines) {
		handleLine(line);
	}
});
process.stdin.on("end", () => {
	if (buffer.trim()) {
		handleLine(buffer);
		buffer = "";
	}
	// Let in-flight tool calls finish and flush before exiting.
	Promise.allSettled([...inFlight])
		.then(() => writeChain)
		.finally(() => process.exit(0));
});
process.stdout.on("error", (error) => {
	if (error?.code === "EPIPE") {
		process.exit(0);
	}
});
