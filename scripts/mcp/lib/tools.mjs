import fs from "node:fs/promises";
import path from "node:path";
import { JSONRPC_INVALID_PARAMS, JsonRpcError } from "./jsonrpc.mjs";
import { fitRecording } from "./postprocess.mjs";

const WINDOW_PARAM = {
	type: "string",
	enum: ["hud-overlay", "editor", "source-selector", "countdown", "update-toast"],
	description:
		"Which Recordly window to target. Defaults to the focused/visible window. " +
		'"hud-overlay" is the floating record bar, "editor" is the video editor.',
};

const LOCATOR_PROPERTIES = {
	ref: {
		type: "string",
		description: 'Element ref from recordly_ui_snapshot (for example "ref_12").',
	},
	selector: { type: "string", description: "CSS selector as a fallback to ref." },
	text: {
		type: "string",
		description: "Visible accessible name/text of the element (exact match preferred).",
	},
};

export const TOOL_DEFINITIONS = [
	{
		name: "recordly_status",
		description:
			"Get Recordly's current state: whether it is recording/paused, the selected capture source, " +
			"the last recorded video path, the open project and the list of open Recordly windows. " +
			"Call this first, and after any recording command, to confirm the actual state.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "recordly_launch",
		description:
			"Launch Recordly with the control server enabled if it is not already reachable, and remember " +
			"that setting so later normal launches keep it on. Uses the installed Recordly.exe when this MCP " +
			"server runs through it, otherwise RECORDLY_APP_PATH. If Recordly is already open without the " +
			"control server, ask the user to quit it first (tray icon → Quit).",
		inputSchema: {
			type: "object",
			properties: {
				appPath: { type: "string", description: "Override RECORDLY_APP_PATH." },
				timeoutMs: {
					type: "number",
					description: "How long to wait for startup (default 30000).",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_list_sources",
		description:
			"List capture sources: displays (type=screen) and application windows (type=window) with their ids, " +
			"titles and app names. Use the result to pick a window for recording only that window " +
			"(no desktop background or taskbar).",
		inputSchema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					enum: ["screen", "window"],
					description: "Filter by source type.",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_select_source",
		description:
			"Select what Recordly will record. Match by exact id, or by (partial) window title / app name, " +
			"or pass type=screen with no name to pick the primary display. Selecting a window source records " +
			"only that window's contents. Recordly also brings the window to the front.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Exact source id from recordly_list_sources." },
				name: {
					type: "string",
					description:
						"Window title, app name or display name to match (case-insensitive substring).",
				},
				type: { type: "string", enum: ["screen", "window"] },
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_arrange_window",
		description:
			"Windows only. Move and resize a target application window to an exact size, centered on the " +
			"primary display by default (default 1280x760: 720px of content plus a ~40px title bar). Do this " +
			"before recording so the clip comes out at the required resolution and so screen-edge overlays " +
			"(for example the 'Claude is using your computer' border, which is drawn at the screen edges) " +
			"stay outside the recorded window region. Window recordings are cropped from the display, so " +
			"anything drawn over the window area would otherwise be captured.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Exact window source id." },
				name: { type: "string", description: "Window title / app name to match." },
				width: {
					type: "number",
					description: "Outer width in physical pixels (default 1280).",
				},
				height: {
					type: "number",
					description: "Outer height in physical pixels (default 760).",
				},
				x: {
					type: "number",
					description: "Left edge in physical pixels (default: centered).",
				},
				y: {
					type: "number",
					description: "Top edge in physical pixels (default: centered).",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_start_recording",
		description:
			"Start recording the selected source. Returns immediately; if a countdown is configured the " +
			"recording starts after it. Optionally set audio/webcam preferences and countdown first.",
		inputSchema: {
			type: "object",
			properties: {
				countdownSeconds: {
					type: "number",
					description: "Countdown before recording starts (0 = none).",
				},
				microphoneEnabled: { type: "boolean" },
				systemAudioEnabled: { type: "boolean" },
				webcamEnabled: { type: "boolean" },
				source: {
					type: "object",
					description:
						"Optional: select a source first (same fields as recordly_select_source).",
					properties: {
						id: { type: "string" },
						name: { type: "string" },
						type: { type: "string", enum: ["screen", "window"] },
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_stop_recording",
		description:
			"Stop the current recording and wait for the video file to be finalized. Returns the recorded " +
			"file path. If saveAs is given, the file is copied there (directories are created) so you can " +
			"name it exactly as needed, for example 'D:/AI캡처/cursor/90_recording_agent_flow.mp4'. " +
			"Recordly opens the editor with the recording afterwards; call recordly_show_hud before the " +
			"next recording. With fit, the saved copy is re-encoded to an exact frame (default 1280x720) " +
			"with the window content letterboxed on a black background so nothing but the app is visible; " +
			"cropTop removes the OS title/menu bar (about 40px for most Windows apps). The untouched raw " +
			"file path is still returned.",
		inputSchema: {
			type: "object",
			properties: {
				saveAs: {
					type: "string",
					description: "Destination path to copy the recording to.",
				},
				timeoutMs: {
					type: "number",
					description: "Max wait for finalization (default 60000).",
				},
				fit: {
					type: "object",
					description:
						'Re-encode the saved copy to an exact size, e.g. {"width":1280,"height":720,"cropTop":40}.',
					properties: {
						width: { type: "number" },
						height: { type: "number" },
						fps: { type: "number" },
						cropTop: {
							type: "number",
							description: "Pixels to crop from the top (title bar).",
						},
						cropBottom: { type: "number" },
						background: {
							type: "string",
							description: "Padding color (default black).",
						},
						keepAudio: { type: "boolean" },
					},
					additionalProperties: false,
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_export_recording",
		description:
			"Export the recording that is open in the Recordly editor through Recordly's own renderer, which " +
			"draws the smoothed mouse cursor (raw captures contain no cursor). Call it after " +
			"recordly_stop_recording, which opens the editor. Defaults produce 'app screen only': aspect 16:9, " +
			"padding 0, black background, no rounded corners or shadow, cursor on, source quality, 30 fps. " +
			"cropTop removes the OS title bar (about 40px) so a window arranged at 1280x760 exports exactly " +
			"1280x720. Waits for the export to finish and returns the output path.",
		inputSchema: {
			type: "object",
			properties: {
				outputPath: {
					type: "string",
					description: "Destination .mp4 path (written directly, no dialog).",
				},
				cropTop: {
					type: "number",
					description: "Pixels of the source to drop from the top (default 40).",
				},
				cropBottom: { type: "number" },
				crop: {
					type: "object",
					description:
						"Explicit normalized crop {x,y,width,height} in 0..1 (overrides cropTop).",
					properties: {
						x: { type: "number" },
						y: { type: "number" },
						width: { type: "number" },
						height: { type: "number" },
					},
					additionalProperties: false,
				},
				aspectRatio: {
					type: "string",
					description: 'e.g. "16:9" (default), "auto", "9:16".',
				},
				padding: {
					type: "number",
					description: "Padding around the frame in px (default 0).",
				},
				background: {
					type: "string",
					description: 'Background: "#000000" (default) or a wallpaper path.',
				},
				showCursor: {
					type: "boolean",
					description: "Render the recorded cursor (default true).",
				},
				quality: { type: "string", enum: ["source", "high", "good", "medium"] },
				fps: { type: "number", description: "30 (default) or 60." },
				encodingMode: { type: "string", enum: ["fast", "balanced", "quality"] },
				timeoutMs: { type: "number" },
			},
			required: ["outputPath"],
			additionalProperties: false,
		},
	},
	{
		name: "recordly_pause_recording",
		description: "Pause the current recording.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "recordly_resume_recording",
		description: "Resume a paused recording.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "recordly_cancel_recording",
		description: "Cancel and discard the current recording.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "recordly_capture_screenshot",
		description:
			"Take a PNG screenshot of a display or of a single application window (window screenshots " +
			"contain only that window, no desktop or taskbar). Saves to outputPath (directories created). " +
			"Set returnImage=true to also get the image back inline for inspection.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Exact source id from recordly_list_sources." },
				name: {
					type: "string",
					description: "Window title / app name / display name to match.",
				},
				type: { type: "string", enum: ["screen", "window"] },
				outputPath: {
					type: "string",
					description: "Where to save the PNG. Defaults to a temp file.",
				},
				returnImage: {
					type: "boolean",
					description: "Also return the PNG inline (default false).",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_capture_window",
		description:
			"Screenshot one of Recordly's own windows (HUD bar, editor, ...). This works even though the HUD " +
			"is hidden from normal screen capture, so use it to see Recordly's UI. Returns the image inline " +
			"by default and saves a PNG.",
		inputSchema: {
			type: "object",
			properties: {
				window: WINDOW_PARAM,
				outputPath: { type: "string" },
				returnImage: {
					type: "boolean",
					description: "Return the PNG inline (default true).",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_ui_snapshot",
		description:
			"Read a Recordly window's UI as a list of interactive elements (buttons, inputs, menus) with " +
			"refs, names, values and bounds, plus visible text. Prefer this over screenshots to find what " +
			"to click. Refs are valid until the next snapshot.",
		inputSchema: {
			type: "object",
			properties: {
				window: WINDOW_PARAM,
				includeHidden: { type: "boolean" },
				limit: { type: "number" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_ui_click",
		description:
			"Click an element in a Recordly window by ref/selector/text, or at window coordinates (x, y).",
		inputSchema: {
			type: "object",
			properties: {
				window: WINDOW_PARAM,
				...LOCATOR_PROPERTIES,
				x: { type: "number" },
				y: { type: "number" },
				button: { type: "string", enum: ["left", "right", "middle"] },
				double: { type: "boolean" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_ui_type",
		description: "Type text into the focused element of a Recordly window.",
		inputSchema: {
			type: "object",
			properties: {
				window: WINDOW_PARAM,
				text: { type: "string" },
			},
			required: ["text"],
			additionalProperties: false,
		},
	},
	{
		name: "recordly_ui_key",
		description:
			'Press a key in a Recordly window (for example "Enter", "Escape", "Space", "a") with optional modifiers.',
		inputSchema: {
			type: "object",
			properties: {
				window: WINDOW_PARAM,
				key: { type: "string" },
				modifiers: {
					type: "array",
					items: { type: "string", enum: ["shift", "control", "alt", "meta"] },
				},
			},
			required: ["key"],
			additionalProperties: false,
		},
	},
	{
		name: "recordly_ui_set_value",
		description:
			"Set the value of an input, textarea, select, checkbox or contenteditable in a Recordly window.",
		inputSchema: {
			type: "object",
			properties: {
				window: WINDOW_PARAM,
				...LOCATOR_PROPERTIES,
				value: { description: "New value (string, number or boolean for checkboxes)." },
			},
			required: ["value"],
			additionalProperties: false,
		},
	},
	{
		name: "recordly_show_hud",
		description:
			"Show and focus the Recordly HUD (record bar). Use before starting a new recording.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "recordly_open_editor",
		description:
			"Open the Recordly editor, optionally loading a .recordly project or a video file.",
		inputSchema: {
			type: "object",
			properties: {
				projectPath: { type: "string" },
				videoPath: { type: "string" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "recordly_close_editor",
		description:
			"Close the editor window (unsaved changes are discarded) and return to the HUD.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "recordly_windows",
		description: "List Recordly's open windows with visibility and bounds.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
];

function textContent(value) {
	return {
		type: "text",
		text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
	};
}

function imageContent(base64, mimeType = "image/png") {
	return { type: "image", data: base64, mimeType };
}

function stripBase64(result) {
	if (!result || typeof result !== "object") return result;
	const { base64: _base64, ...rest } = result;
	return rest;
}

async function copyRecording(sourcePath, destination) {
	const target = path.resolve(destination);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.copyFile(sourcePath, target);
	return target;
}

/**
 * Executes an MCP tool call against the control client. Returns an MCP
 * `tools/call` result ({ content, isError? }).
 */
export async function runTool(client, name, args = {}, { launch } = {}) {
	const params = args && typeof args === "object" ? args : {};
	switch (name) {
		case "recordly_status":
			return { content: [textContent(await client.call("status"))] };
		case "recordly_launch": {
			if (!launch) {
				throw new JsonRpcError(
					JSONRPC_INVALID_PARAMS,
					"Launching is not available in this server.",
				);
			}
			try {
				await client.call("ping", {}, { timeoutMs: 2_000 });
				return { content: [textContent({ launched: false, reason: "already running" })] };
			} catch {
				const result = await launch({
					appPath: params.appPath,
					timeoutMs: params.timeoutMs,
				});
				return {
					content: [
						textContent({ launched: true, pid: result.pid, port: result.info.port }),
					],
				};
			}
		}
		case "recordly_windows":
			return { content: [textContent(await client.call("windows.list"))] };
		case "recordly_list_sources":
			return { content: [textContent(await client.call("sources.list", params))] };
		case "recordly_select_source":
			return { content: [textContent(await client.call("sources.select", params))] };
		case "recordly_start_recording": {
			const {
				source,
				countdownSeconds,
				microphoneEnabled,
				systemAudioEnabled,
				webcamEnabled,
			} = params;
			const steps = {};
			if (source && typeof source === "object") {
				steps.selected = await client.call("sources.select", source);
			}
			const preferences = {};
			if (typeof microphoneEnabled === "boolean")
				preferences.microphoneEnabled = microphoneEnabled;
			if (typeof systemAudioEnabled === "boolean")
				preferences.systemAudioEnabled = systemAudioEnabled;
			if (typeof webcamEnabled === "boolean") preferences.webcamEnabled = webcamEnabled;
			if (typeof countdownSeconds === "number")
				preferences.countdownSeconds = countdownSeconds;
			if (Object.keys(preferences).length > 0) {
				steps.preferences = await client.call("recording.preferences", preferences);
			}
			await client.call("hud.show");
			steps.recording = await client.call("recording.start", {});
			return { content: [textContent(steps)] };
		}
		case "recordly_stop_recording": {
			const result = await client.call(
				"recording.stop",
				{ waitForFile: true, timeoutMs: params.timeoutMs },
				{ timeoutMs: (params.timeoutMs ?? 60_000) + 15_000 },
			);
			let savedAs = null;
			let fitted = null;
			if (typeof params.saveAs === "string" && params.saveAs.trim() && result?.videoPath) {
				if (params.fit && typeof params.fit === "object") {
					const target = path.resolve(params.saveAs);
					fitted = await fitRecording(result.videoPath, target, params.fit);
					savedAs = target;
				} else {
					savedAs = await copyRecording(result.videoPath, params.saveAs);
				}
			}
			return {
				content: [
					textContent({
						...result,
						savedAs,
						...(fitted ? { fit: { ffmpeg: fitted.ffmpeg, filters: fitted.args } } : {}),
					}),
				],
			};
		}
		case "recordly_export_recording": {
			const {
				cropTop = 40,
				aspectRatio = "16:9",
				padding = 0,
				background = "#000000",
				showCursor = true,
				quality = "source",
				fps = 30,
				timeoutMs,
				...rest
			} = params;
			const result = await client.call(
				"editor.export",
				{
					...rest,
					cropTop,
					aspectRatio,
					padding,
					background,
					borderRadius: 0,
					shadow: 0,
					showCursor,
					quality,
					fps,
					timeoutMs,
				},
				{ timeoutMs: (timeoutMs ?? 20 * 60_000) + 15_000 },
			);
			return { content: [textContent(result)] };
		}
		case "recordly_arrange_window":
			return { content: [textContent(await client.call("sources.arrange", params))] };
		case "recordly_pause_recording":
			return { content: [textContent(await client.call("recording.pause"))] };
		case "recordly_resume_recording":
			return { content: [textContent(await client.call("recording.resume"))] };
		case "recordly_cancel_recording":
			return { content: [textContent(await client.call("recording.cancel"))] };
		case "recordly_capture_screenshot": {
			const { returnImage, ...rest } = params;
			const result = await client.call("screen.capture", {
				...rest,
				base64: returnImage === true,
			});
			const content = [textContent(stripBase64(result))];
			if (result?.base64) content.push(imageContent(result.base64, result.mimeType));
			return { content };
		}
		case "recordly_capture_window": {
			const { returnImage, ...rest } = params;
			const wantImage = returnImage !== false;
			const result = await client.call("windows.capture", { ...rest, base64: wantImage });
			const content = [textContent(stripBase64(result))];
			if (result?.base64) content.push(imageContent(result.base64, result.mimeType));
			return { content };
		}
		case "recordly_ui_snapshot":
			return { content: [textContent(await client.call("ui.snapshot", params))] };
		case "recordly_ui_click":
			return { content: [textContent(await client.call("ui.click", params))] };
		case "recordly_ui_type":
			return { content: [textContent(await client.call("ui.type", params))] };
		case "recordly_ui_key":
			return { content: [textContent(await client.call("ui.key", params))] };
		case "recordly_ui_set_value":
			return { content: [textContent(await client.call("ui.setValue", params))] };
		case "recordly_show_hud":
			return { content: [textContent(await client.call("hud.show"))] };
		case "recordly_open_editor":
			return { content: [textContent(await client.call("editor.open", params))] };
		case "recordly_close_editor":
			return { content: [textContent(await client.call("editor.close"))] };
		default:
			throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
	}
}
