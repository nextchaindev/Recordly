import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import { USER_DATA_PATH } from "../appPaths";
import { bringSelectedWindowForward } from "../ipc/register/sources";
import {
	countdownInProgress,
	countdownRemaining,
	currentProjectPath,
	currentRecordingSession,
	currentVideoPath,
	ffmpegScreenRecordingActive,
	nativeCapturePaused,
	nativeScreenRecordingActive,
	selectedSource,
	windowsCapturePaused,
	windowsNativeCaptureActive,
} from "../ipc/state";
import { parseWindowId } from "../ipc/utils";
import {
	arrangeWindowsWindow,
	probeWindowsWindowStyles,
	resolveWindowsWindowBounds,
} from "../ipc/windowsWindowControl";
import {
	buildDiscoveryInfo,
	CONTROL_DISCOVERY_FILE_NAME,
	ControlError,
	type ControlRequest,
	type ControlSourceSummary,
	isAuthorizedRequest,
	isLoopbackHost,
	matchControlSources,
	parseControlRequest,
	readNumberParam,
	readStringParam,
	requireStringParam,
} from "./protocol";

export type ControlWindowType =
	| "hud-overlay"
	| "editor"
	| "source-selector"
	| "countdown"
	| "update-toast";

export type ControlServerHost = {
	getHudWindow: () => BrowserWindow | null;
	showHud: () => void;
	openEditor: () => void;
	closeEditor: () => void;
};

type RendererCommandResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

const RENDERER_COMMAND_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;
const DISCOVERY_FILE_PATH = path.join(USER_DATA_PATH, CONTROL_DISCOVERY_FILE_NAME);

let server: Server | null = null;
let serverToken = "";
let serverPort = 0;
let recordingStateChangedAt: string | null = null;
let recordingActiveFromRenderer = false;
const pendingRendererCommands = new Map<
	string,
	{ resolve: (value: RendererCommandResult) => void; timer: NodeJS.Timeout }
>();

function getWindowType(window: BrowserWindow): ControlWindowType | "unknown" {
	try {
		const url = new URL(window.webContents.getURL());
		const type = url.searchParams.get("windowType");
		switch (type) {
			case "hud-overlay":
			case "editor":
			case "source-selector":
			case "countdown":
			case "update-toast":
				return type;
			default:
				return "unknown";
		}
	} catch {
		return "unknown";
	}
}

function listWindows() {
	return BrowserWindow.getAllWindows()
		.filter((window) => !window.isDestroyed())
		.map((window) => {
			const bounds = window.getBounds();
			return {
				id: window.id,
				windowType: getWindowType(window),
				title: window.getTitle(),
				visible: window.isVisible(),
				focused: window.isFocused(),
				minimized: window.isMinimized(),
				bounds,
			};
		});
}

function findWindow(params: Record<string, unknown>, fallback: ControlWindowType | null) {
	const requestedType = readStringParam(params, "window") ?? fallback;
	const windowId = readNumberParam(params, "windowId", Number.NaN);
	const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());

	if (Number.isFinite(windowId)) {
		const byId = windows.find((window) => window.id === windowId);
		if (!byId) {
			throw new ControlError("window_not_found", `No window with id ${windowId}.`, 404);
		}
		return byId;
	}

	if (requestedType) {
		const byType = windows.find((window) => getWindowType(window) === requestedType);
		if (!byType) {
			throw new ControlError(
				"window_not_found",
				`No "${requestedType}" window is open. Open windows: ${
					windows.map((window) => getWindowType(window)).join(", ") || "none"
				}.`,
				404,
			);
		}
		return byType;
	}

	const focused = windows.find((window) => window.isFocused());
	if (focused) {
		return focused;
	}
	const visible = windows.find((window) => window.isVisible());
	if (visible) {
		return visible;
	}
	if (windows[0]) {
		return windows[0];
	}
	throw new ControlError("window_not_found", "Recordly has no open windows.", 404);
}

function getHudWindowOrThrow(host: ControlServerHost) {
	const hud = host.getHudWindow();
	if (!hud || hud.isDestroyed()) {
		throw new ControlError(
			"hud_unavailable",
			"The Recordly HUD window is not running, so recording commands cannot be dispatched.",
			409,
		);
	}
	return hud;
}

function sendRendererCommand(
	window: BrowserWindow,
	name: string,
	args: Record<string, unknown>,
	timeoutMs = RENDERER_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
	const id = randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingRendererCommands.delete(id);
			reject(
				new ControlError(
					"renderer_timeout",
					`Renderer did not answer "${name}" within ${timeoutMs}ms.`,
					504,
				),
			);
		}, timeoutMs);
		pendingRendererCommands.set(id, {
			timer,
			resolve: (payload) => {
				if (payload.ok) {
					resolve(payload.result);
				} else {
					reject(
						new ControlError(
							"renderer_error",
							payload.error ?? `Renderer rejected "${name}".`,
							422,
						),
					);
				}
			},
		});
		window.webContents.send("control-command", { id, name, args });
	});
}

ipcMain.on("control-command-result", (_event, payload: RendererCommandResult) => {
	if (!payload || typeof payload.id !== "string") {
		return;
	}
	const pending = pendingRendererCommands.get(payload.id);
	if (!pending) {
		return;
	}
	clearTimeout(pending.timer);
	pendingRendererCommands.delete(payload.id);
	pending.resolve(payload);
});

export function noteRecordingStateForControl(recording: boolean) {
	recordingActiveFromRenderer = recording;
	recordingStateChangedAt = new Date().toISOString();
}

function buildStatus() {
	const recording =
		recordingActiveFromRenderer ||
		nativeScreenRecordingActive ||
		windowsNativeCaptureActive ||
		ffmpegScreenRecordingActive;
	return {
		appVersion: app.getVersion(),
		platform: process.platform,
		recording,
		paused: nativeCapturePaused || windowsCapturePaused,
		recordingStateChangedAt,
		countdown: countdownInProgress ? countdownRemaining : null,
		selectedSource: selectedSource
			? {
					id: selectedSource.id ?? null,
					name: selectedSource.name,
					sourceType: selectedSource.sourceType ?? null,
					appName: selectedSource.appName ?? null,
				}
			: null,
		currentVideoPath,
		currentProjectPath,
		currentRecordingSession: currentRecordingSession
			? {
					videoPath: currentRecordingSession.videoPath,
					webcamPath: currentRecordingSession.webcamPath ?? null,
				}
			: null,
		windows: listWindows(),
	};
}

/**
 * Main-process source listing used when the HUD renderer is not available
 * (for example while the editor is open after a recording). Names follow the
 * HUD's conventions closely enough for matching by title.
 */
async function listSourcesInMain(
	types: Array<"screen" | "window">,
): Promise<ControlSourceSummary[]> {
	const electronSources = await desktopCapturer.getSources({
		types,
		thumbnailSize: { width: 1, height: 1 },
		fetchWindowIcons: false,
	});
	const displays = [...screen.getAllDisplays()].sort(
		(left, right) => left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y,
	);
	const primaryId = String(screen.getPrimaryDisplay().id);
	const ownTitles = new Set(
		BrowserWindow.getAllWindows()
			.filter((window) => !window.isDestroyed())
			.map((window) => window.getTitle().trim().toLowerCase()),
	);
	const result: ControlSourceSummary[] = [];
	for (const source of electronSources) {
		if (source.id.startsWith("screen:")) {
			const displayId = String(source.display_id ?? "");
			const index = displays.findIndex((display) => String(display.id) === displayId);
			const label = index >= 0 ? `Screen ${index + 1}` : source.name;
			result.push({
				id: source.id,
				name: displayId === primaryId ? `${label} (Primary)` : label,
				sourceType: "screen",
				display_id: displayId,
			});
			continue;
		}
		const title = source.name.trim();
		if (!title || ownTitles.has(title.toLowerCase()) || title.toLowerCase() === "recordly") {
			continue;
		}
		result.push({ id: source.id, name: title, sourceType: "window", windowTitle: title });
	}
	return result;
}

/**
 * Orders window candidates that share a title so the largest real window
 * wins: overlay/mascot windows often reuse an app's title but are tiny.
 * Screens keep their position at the front.
 */
async function rankWindowCandidates<T extends ControlSourceSummary>(candidates: T[]): Promise<T[]> {
	const windows = candidates.filter((candidate) => candidate.sourceType === "window");
	if (windows.length < 2 || process.platform !== "win32") {
		return candidates;
	}
	const scores = new Map<string, number>();
	try {
		const ids = windows
			.map((candidate) => ({ candidate, windowId: parseWindowId(candidate.id) }))
			.filter((entry): entry is { candidate: T; windowId: number } =>
				Boolean(entry.windowId),
			);
		const infos = await probeWindowsWindowStyles(ids.map((entry) => entry.windowId));
		for (const entry of ids) {
			const info = infos.find((row) => row.windowId === entry.windowId);
			if (!info) continue;
			// Real app windows have a caption and are neither tool windows nor
			// click-through overlays; mascots/HUD-like overlays usually are.
			const realWindow = info.hasCaption && !info.toolWindow && !info.transparent;
			const score =
				(realWindow ? 1_000_000_000 : 0) +
				(info.visible ? 100_000_000 : 0) +
				Math.min(99_999_999, info.width * info.height);
			scores.set(entry.candidate.id, score);
		}
	} catch (error) {
		console.warn("[control-server] Window style probe failed:", error);
	}
	const screens = candidates.filter((candidate) => candidate.sourceType === "screen");
	const sortedWindows = [...windows].sort(
		(left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0),
	);
	return [...screens, ...sortedWindows];
}

async function listSourcesViaHud(
	host: ControlServerHost,
	types: Array<"screen" | "window">,
): Promise<ControlSourceSummary[]> {
	const hud = host.getHudWindow();
	if (!hud || hud.isDestroyed()) {
		return listSourcesInMain(types);
	}
	const raw = (await sendRendererCommand(hud, "sources.list", { types })) as Array<
		Record<string, unknown>
	>;
	return raw.map((source) => ({
		id: String(source.id ?? ""),
		name: String(source.name ?? ""),
		sourceType:
			source.sourceType === "window" || String(source.id ?? "").startsWith("window:")
				? "window"
				: "screen",
		appName: typeof source.appName === "string" ? source.appName : undefined,
		windowTitle: typeof source.windowTitle === "string" ? source.windowTitle : undefined,
		display_id: typeof source.display_id === "string" ? source.display_id : undefined,
	}));
}

function resolveOutputPath(params: Record<string, unknown>, defaultName: string): string {
	const requested = readStringParam(params, "outputPath");
	if (requested) {
		return path.resolve(requested);
	}
	return path.join(app.getPath("temp"), "recordly-control", defaultName);
}

async function writePng(filePath: string, png: Buffer) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, png);
}

async function capturePageWithRetry(window: BrowserWindow, attempts = 8) {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const image = await window.webContents.capturePage();
			if (!image.isEmpty()) {
				return image;
			}
			lastError = new Error("Captured image was empty.");
		} catch (error) {
			// Right after a window is created the compositor may not have a
			// frame yet (UnknownVizError); give it a moment and try again.
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new ControlError(
		"capture_failed",
		`Could not capture the window: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		500,
	);
}

async function captureWindow(params: Record<string, unknown>) {
	const window = findWindow(params, null);
	const image = await capturePageWithRetry(window);
	const size = image.getSize();
	const includeBase64 = params.base64 === true;
	const outputPath = resolveOutputPath(
		params,
		`window-${getWindowType(window)}-${Date.now()}.png`,
	);
	const png = image.toPNG();
	await writePng(outputPath, png);
	return {
		windowType: getWindowType(window),
		windowId: window.id,
		width: size.width,
		height: size.height,
		outputPath,
		...(includeBase64 ? { base64: png.toString("base64"), mimeType: "image/png" } : {}),
	};
}

async function captureSource(host: ControlServerHost, params: Record<string, unknown>) {
	const requestedType =
		params.type === "screen" || params.type === "window" ? params.type : undefined;
	const types: Array<"screen" | "window"> = requestedType
		? [requestedType]
		: ["screen", "window"];
	const sources = await listSourcesViaHud(host, types);
	const candidates = await rankWindowCandidates(
		matchControlSources(sources, {
			id: params.id,
			name: params.name,
			type: requestedType,
		}),
	);
	if (candidates.length === 0) {
		throw new ControlError(
			"source_not_found",
			`No capture source matched. Available: ${sources
				.map((source) => `${source.sourceType}:"${source.name}"`)
				.join(", ")}`,
			404,
		);
	}

	const primary = screen.getPrimaryDisplay();
	const largest = screen.getAllDisplays().reduce(
		(acc, display) => ({
			width: Math.max(acc.width, Math.round(display.size.width * display.scaleFactor)),
			height: Math.max(acc.height, Math.round(display.size.height * display.scaleFactor)),
		}),
		{
			width: Math.round(primary.size.width * primary.scaleFactor),
			height: Math.round(primary.size.height * primary.scaleFactor),
		},
	);

	// Minimized or occluded windows yield empty frames. Raise window sources
	// first (unless raise=false) and fall back through the other candidates
	// that match the same query.
	let match = candidates[0];
	let electronSource: Electron.DesktopCapturerSource | null = null;
	for (const candidate of candidates) {
		if (candidate.sourceType === "window" && params.raise !== false) {
			await bringSelectedWindowForward({
				id: candidate.id,
				name: candidate.name,
				appName: candidate.appName,
			});
		}
		const electronSources = await desktopCapturer.getSources({
			types: [candidate.sourceType],
			thumbnailSize: largest,
			fetchWindowIcons: false,
		});
		const found =
			electronSources.find((source) => source.id === candidate.id) ??
			electronSources.find(
				(source) =>
					candidate.sourceType === "screen" &&
					String(source.display_id) === candidate.display_id,
			);
		if (found && !found.thumbnail.isEmpty()) {
			match = candidate;
			electronSource = found;
			break;
		}
	}
	if (!electronSource) {
		throw new ControlError(
			"capture_failed",
			`Capture source "${match.name}" was found but no frame could be read. The window may be minimized, or screen recording permission is missing.`,
			500,
		);
	}

	const png = electronSource.thumbnail.toPNG();
	const size = electronSource.thumbnail.getSize();
	const safeName = match.name.replace(/[^\w.-]+/g, "_").slice(0, 48) || "source";
	const outputPath = resolveOutputPath(params, `${safeName}-${Date.now()}.png`);
	await writePng(outputPath, png);
	return {
		source: match,
		width: size.width,
		height: size.height,
		outputPath,
		...(params.base64 === true
			? { base64: png.toString("base64"), mimeType: "image/png" }
			: {}),
	};
}

async function locateUiElement(window: BrowserWindow, params: Record<string, unknown>) {
	const ref = readStringParam(params, "ref");
	const selector = readStringParam(params, "selector");
	const text = readStringParam(params, "text");
	if (!ref && !selector && !text) {
		throw new ControlError("invalid_params", 'Provide one of "ref", "selector" or "text".');
	}
	return (await sendRendererCommand(window, "ui.locate", { ref, selector, text })) as {
		x: number;
		y: number;
		width: number;
		height: number;
	};
}

async function clickUi(params: Record<string, unknown>) {
	const window = findWindow(params, null);
	let x = readNumberParam(params, "x", Number.NaN);
	let y = readNumberParam(params, "y", Number.NaN);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		const bounds = await locateUiElement(window, params);
		x = bounds.x + bounds.width / 2;
		y = bounds.y + bounds.height / 2;
	}
	const button =
		params.button === "right" ? "right" : params.button === "middle" ? "middle" : "left";
	const clickCount = params.double === true ? 2 : 1;
	const contents = window.webContents;
	contents.sendInputEvent({ type: "mouseMove", x, y });
	for (let index = 0; index < clickCount; index += 1) {
		contents.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: index + 1 });
		contents.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: index + 1 });
	}
	return { windowType: getWindowType(window), x: Math.round(x), y: Math.round(y), button };
}

function typeUi(params: Record<string, unknown>) {
	const window = findWindow(params, null);
	const text = requireStringParam(params, "text");
	return window.webContents.insertText(text).then(() => ({
		windowType: getWindowType(window),
		length: text.length,
	}));
}

function pressKeyUi(params: Record<string, unknown>) {
	const window = findWindow(params, null);
	const key = requireStringParam(params, "key");
	const modifiers = Array.isArray(params.modifiers)
		? (params.modifiers.filter(
				(modifier): modifier is "shift" | "control" | "alt" | "meta" =>
					modifier === "shift" ||
					modifier === "control" ||
					modifier === "alt" ||
					modifier === "meta",
			) as Array<"shift" | "control" | "alt" | "meta">)
		: [];
	const contents = window.webContents;
	contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
	if (key.length === 1) {
		contents.sendInputEvent({ type: "char", keyCode: key, modifiers });
	}
	contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
	return { windowType: getWindowType(window), key, modifiers };
}

async function waitForRecordingFile(
	previousVideoPath: string | null,
	timeoutMs: number,
): Promise<{ videoPath: string; webcamPath: string | null }> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const sessionPath = currentRecordingSession?.videoPath ?? null;
		const candidate = sessionPath ?? currentVideoPath;
		if (candidate && candidate !== previousVideoPath) {
			try {
				const stats = await fs.stat(candidate);
				if (stats.size > 0) {
					return {
						videoPath: candidate,
						webcamPath: currentRecordingSession?.webcamPath ?? null,
					};
				}
			} catch {
				// File not visible yet; keep polling.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new ControlError(
		"recording_file_timeout",
		`No new recording file appeared within ${timeoutMs}ms.`,
		504,
	);
}

async function dispatch(host: ControlServerHost, request: ControlRequest): Promise<unknown> {
	const { method, params } = request;
	switch (method) {
		case "ping":
			return { ok: true, pid: process.pid };
		case "status":
			return buildStatus();
		case "windows.list":
			return listWindows();
		case "windows.capture":
			return captureWindow(params);
		case "windows.focus": {
			const window = findWindow(params, null);
			if (getWindowType(window) === "hud-overlay") {
				host.showHud();
			} else {
				if (window.isMinimized()) window.restore();
				window.show();
				window.focus();
			}
			return { windowType: getWindowType(window) };
		}
		case "hud.show":
			host.showHud();
			return { ok: true };
		case "editor.open": {
			const projectPath = readStringParam(params, "projectPath");
			const videoPath = readStringParam(params, "videoPath");
			if (projectPath || videoPath) {
				const hud = getHudWindowOrThrow(host);
				return sendRendererCommand(hud, "project.open", { projectPath, videoPath });
			}
			host.openEditor();
			return { ok: true };
		}
		case "editor.close":
			host.closeEditor();
			return { ok: true };
		case "editor.state": {
			const editor = findWindow({ window: "editor" }, "editor");
			return sendRendererCommand(editor, "editor.state", {});
		}
		case "editor.export": {
			const outputPath = path.resolve(requireStringParam(params, "outputPath"));
			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			const editor = findWindow({ window: "editor" }, "editor");
			const timeoutMs = readNumberParam(params, "timeoutMs", 20 * 60_000, {
				min: 30_000,
				max: 2 * 60 * 60_000,
			});
			const result = (await sendRendererCommand(
				editor,
				"editor.export",
				{ ...params, outputPath },
				timeoutMs,
			)) as Record<string, unknown>;
			let stats: { size: number } | null = null;
			try {
				stats = await fs.stat(outputPath);
			} catch {
				stats = null;
			}
			if (!stats || stats.size === 0) {
				throw new ControlError(
					"export_failed",
					`Export finished but no file was written to ${outputPath}.`,
					500,
				);
			}
			return { ...result, outputPath, sizeBytes: stats.size };
		}
		case "sources.list": {
			const types =
				params.type === "screen" || params.type === "window"
					? [params.type]
					: (["screen", "window"] as Array<"screen" | "window">);
			return listSourcesViaHud(host, types as Array<"screen" | "window">);
		}
		case "sources.select": {
			const requestedType =
				params.type === "screen" || params.type === "window" ? params.type : undefined;
			const sources = await listSourcesViaHud(
				host,
				requestedType ? [requestedType] : ["screen", "window"],
			);
			const ranked = await rankWindowCandidates(
				matchControlSources(sources, {
					id: params.id,
					name: params.name,
					type: requestedType,
				}),
			);
			const match = ranked[0] ?? null;
			if (!match) {
				throw new ControlError(
					"source_not_found",
					`No capture source matched. Available: ${sources
						.map((source) => `${source.sourceType}:"${source.name}"`)
						.join(", ")}`,
					404,
				);
			}
			const hud = host.getHudWindow();
			if (!hud || hud.isDestroyed()) {
				throw new ControlError(
					"hud_unavailable",
					"The Recordly HUD is not open (the editor is showing). Call hud.show first, then select the source again.",
					409,
				);
			}
			await sendRendererCommand(hud, "sources.select", { id: match.id });
			return {
				selected: match,
				alternatives: ranked
					.slice(1)
					.map((source) => ({ id: source.id, name: source.name })),
			};
		}
		case "sources.arrange": {
			if (process.platform !== "win32") {
				throw new ControlError(
					"unsupported_platform",
					"sources.arrange is only implemented on Windows.",
					501,
				);
			}
			const sources = await listSourcesViaHud(host, ["window"]);
			const ranked = await rankWindowCandidates(
				matchControlSources(sources, { id: params.id, name: params.name, type: "window" }),
			);
			const target = ranked[0];
			if (!target) {
				throw new ControlError("source_not_found", "No window matched.", 404);
			}
			const windowId = parseWindowId(target.id);
			if (!windowId) {
				throw new ControlError("invalid_params", `Cannot parse window id "${target.id}".`);
			}
			const width = readNumberParam(params, "width", 1280, { min: 200, max: 16_000 });
			const height = readNumberParam(params, "height", 760, { min: 150, max: 16_000 });
			const display = screen.getPrimaryDisplay();
			const scale = display.scaleFactor;
			const workArea = display.workArea;
			const centeredX = workArea.x + (workArea.width - width / scale) / 2;
			const centeredY = workArea.y + (workArea.height - height / scale) / 2;
			const x = readNumberParam(params, "x", Math.round(centeredX * scale));
			const y = readNumberParam(params, "y", Math.round(centeredY * scale));
			await arrangeWindowsWindow(windowId, { x, y, width, height });
			await new Promise((resolve) => setTimeout(resolve, 200));
			const bounds = await resolveWindowsWindowBounds({
				id: target.id,
				name: target.name,
				windowTitle: target.windowTitle,
			});
			return { window: target, requested: { x, y, width, height }, bounds };
		}
		case "screen.capture":
			return captureSource(host, params);
		case "recording.start":
		case "recording.stop":
		case "recording.pause":
		case "recording.resume":
		case "recording.cancel": {
			const hud = getHudWindowOrThrow(host);
			const previousVideoPath = currentRecordingSession?.videoPath ?? currentVideoPath;
			const result = await sendRendererCommand(hud, method, params);
			if (method === "recording.stop" && params.waitForFile !== false) {
				const timeoutMs = readNumberParam(params, "timeoutMs", 60_000, {
					min: 1_000,
					max: 10 * 60_000,
				});
				const file = await waitForRecordingFile(previousVideoPath, timeoutMs);
				return { ...(result as Record<string, unknown>), ...file };
			}
			return result;
		}
		case "recording.waitForFile": {
			const timeoutMs = readNumberParam(params, "timeoutMs", 60_000, {
				min: 1_000,
				max: 10 * 60_000,
			});
			const previous = readStringParam(params, "previousVideoPath");
			return waitForRecordingFile(previous, timeoutMs);
		}
		case "recording.preferences": {
			const hud = getHudWindowOrThrow(host);
			return sendRendererCommand(hud, "recording.preferences", params);
		}
		case "ui.snapshot": {
			const window = findWindow(params, null);
			const snapshot = await sendRendererCommand(window, "ui.snapshot", params);
			return {
				windowType: getWindowType(window),
				windowId: window.id,
				...(snapshot as object),
			};
		}
		case "ui.click":
			return clickUi(params);
		case "ui.type":
			return typeUi(params);
		case "ui.key":
			return pressKeyUi(params);
		case "ui.setValue": {
			const window = findWindow(params, null);
			return sendRendererCommand(window, "ui.setValue", params);
		}
		case "renderer.command": {
			const window = findWindow(params, "hud-overlay");
			const name = requireStringParam(params, "name");
			const args =
				params.args && typeof params.args === "object" && !Array.isArray(params.args)
					? (params.args as Record<string, unknown>)
					: {};
			return sendRendererCommand(window, name, args);
		}
		default:
			throw new ControlError("unknown_method", `Unknown control method "${method}".`, 404);
	}
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		request.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				reject(new ControlError("payload_too_large", "Request body too large.", 413));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		request.on("error", reject);
	});
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(JSON.stringify(payload));
}

async function handleRequest(
	host: ControlServerHost,
	request: IncomingMessage,
	response: ServerResponse,
) {
	try {
		if (!isLoopbackHost(request.headers.host)) {
			throw new ControlError(
				"forbidden_host",
				"Control server only accepts loopback requests.",
				403,
			);
		}
		if (!isAuthorizedRequest(request.headers.authorization, serverToken)) {
			throw new ControlError("unauthorized", "Missing or invalid bearer token.", 401);
		}
		if (request.method !== "POST" || request.url !== "/rpc") {
			throw new ControlError("not_found", "POST /rpc is the only endpoint.", 404);
		}
		const body = await readBody(request);
		const parsed = parseControlRequest(body);
		const result = await dispatch(host, parsed);
		writeJson(response, 200, { ok: true, result });
	} catch (error) {
		if (error instanceof ControlError) {
			writeJson(response, error.status, {
				ok: false,
				error: { code: error.code, message: error.message },
			});
			return;
		}
		console.error("[control-server] Unhandled error:", error);
		writeJson(response, 500, {
			ok: false,
			error: { code: "internal_error", message: String(error) },
		});
	}
}

export async function startControlServer(host: ControlServerHost): Promise<{
	port: number;
	discoveryFilePath: string;
}> {
	if (server) {
		return { port: serverPort, discoveryFilePath: DISCOVERY_FILE_PATH };
	}

	serverToken = randomBytes(24).toString("hex");
	const requestedPort = Number(process.env["RECORDLY_CONTROL_PORT"] ?? 0);
	const httpServer = createServer((request, response) => {
		void handleRequest(host, request, response);
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(Number.isFinite(requestedPort) ? requestedPort : 0, "127.0.0.1", () => {
			httpServer.off("error", reject);
			resolve();
		});
	});

	const address = httpServer.address();
	if (!address || typeof address === "string") {
		httpServer.close();
		throw new Error("Control server did not bind to a TCP port.");
	}

	server = httpServer;
	serverPort = address.port;
	const info = buildDiscoveryInfo({
		port: serverPort,
		token: serverToken,
		pid: process.pid,
		appVersion: app.getVersion(),
	});
	await fs.mkdir(path.dirname(DISCOVERY_FILE_PATH), { recursive: true });
	await fs.writeFile(DISCOVERY_FILE_PATH, JSON.stringify(info, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	console.log(`[control-server] Listening on http://127.0.0.1:${serverPort}/rpc`);
	console.log(`[control-server] Discovery file: ${DISCOVERY_FILE_PATH}`);
	return { port: serverPort, discoveryFilePath: DISCOVERY_FILE_PATH };
}

export async function stopControlServer(): Promise<void> {
	const active = server;
	server = null;
	for (const pending of pendingRendererCommands.values()) {
		clearTimeout(pending.timer);
	}
	pendingRendererCommands.clear();
	if (active) {
		await new Promise<void>((resolve) => active.close(() => resolve()));
	}
	try {
		await fs.rm(DISCOVERY_FILE_PATH, { force: true });
	} catch {
		// Best effort cleanup.
	}
}

export function getControlDiscoveryFilePath(): string {
	return DISCOVERY_FILE_PATH;
}
