import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONTROL_DISCOVERY_FILE_NAME = "control-server.json";

/**
 * Candidate discovery-file locations, most specific first. Mirrors Electron's
 * `app.getPath("userData")` for the packaged app ("Recordly") and the dev
 * build ("Recordly-dev", see electron/appPaths.ts).
 */
export function getDiscoveryFileCandidates({
	platform = process.platform,
	env = process.env,
	homeDir = os.homedir(),
} = {}) {
	const explicit = env.RECORDLY_CONTROL_FILE;
	if (explicit) {
		return [explicit];
	}

	const appNames = ["Recordly", "Recordly-dev"];
	let baseDirs;
	if (platform === "win32") {
		const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
		baseDirs = [appData];
	} else if (platform === "darwin") {
		baseDirs = [path.join(homeDir, "Library", "Application Support")];
	} else {
		const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
		baseDirs = [configHome];
	}

	return baseDirs.flatMap((baseDir) =>
		appNames.map((appName) => path.join(baseDir, appName, CONTROL_DISCOVERY_FILE_NAME)),
	);
}

export function parseDiscoveryInfo(raw) {
	const parsed = JSON.parse(raw);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		typeof parsed.port !== "number" ||
		typeof parsed.token !== "string"
	) {
		throw new Error("Discovery file is malformed (expected { port, token }).");
	}
	return parsed;
}

function isProcessAlive(pid) {
	if (typeof pid !== "number" || !Number.isFinite(pid)) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

export async function readDiscoveryInfo(options = {}) {
	const candidates = getDiscoveryFileCandidates(options);
	const errors = [];
	for (const candidate of candidates) {
		try {
			const raw = await fs.readFile(candidate, "utf-8");
			const info = parseDiscoveryInfo(raw);
			if (!isProcessAlive(info.pid)) {
				errors.push(`${candidate}: stale (process ${info.pid} is gone)`);
				continue;
			}
			return { ...info, filePath: candidate };
		} catch (error) {
			errors.push(`${candidate}: ${error?.code ?? error?.message ?? error}`);
		}
	}
	const hint =
		"Start Recordly with the control server enabled (RECORDLY_CONTROL_SERVER=1, " +
		'the --control-server flag, or "controlServerEnabled": true in app-settings.json).';
	throw new Error(`Recordly control server not found. ${hint}\nTried:\n${errors.join("\n")}`);
}

export class RecordlyControlClient {
	constructor(options = {}) {
		this.options = options;
		this.info = null;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	async connect() {
		this.info = await readDiscoveryInfo(this.options);
		return this.info;
	}

	async call(method, params = {}, { timeoutMs = 120_000 } = {}) {
		if (!this.info) {
			await this.connect();
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await this.fetchImpl(`http://127.0.0.1:${this.info.port}/rpc`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.info.token}`,
				},
				body: JSON.stringify({ method, params }),
				signal: controller.signal,
			});
			const payload = await response.json().catch(() => null);
			if (!payload || payload.ok !== true) {
				const message =
					payload?.error?.message ?? `Control server returned HTTP ${response.status}.`;
				const code = payload?.error?.code ?? `http_${response.status}`;
				const error = new Error(`${message} (${code})`);
				error.code = code;
				throw error;
			}
			return payload.result;
		} catch (error) {
			if (error?.name === "AbortError") {
				throw new Error(`Control call "${method}" timed out after ${timeoutMs}ms.`);
			}
			if (error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED") {
				this.info = null;
				throw new Error(
					"Recordly control server is not reachable (connection refused). Is Recordly running?",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * When the MCP server runs through the installed Recordly.exe
 * (ELECTRON_RUN_AS_NODE=1), that executable is also the app to launch.
 */
export function getDefaultRecordlyAppPath({
	env = process.env,
	execPath = process.execPath,
	versions = process.versions,
} = {}) {
	if (env.RECORDLY_APP_PATH) {
		return env.RECORDLY_APP_PATH;
	}
	if (versions?.electron && env.ELECTRON_RUN_AS_NODE) {
		return execPath;
	}
	return undefined;
}

/**
 * Persists "controlServerEnabled": true in Recordly's app-settings.json so the
 * control server is also on when the user starts Recordly normally later.
 */
export async function enableControlServerSetting(options = {}) {
	const candidates = getDiscoveryFileCandidates({
		...options,
		env: { ...(options.env ?? process.env), RECORDLY_CONTROL_FILE: undefined },
	});
	const settingsPath = path.join(path.dirname(candidates[0]), "app-settings.json");
	let store = {};
	try {
		const parsed = JSON.parse((await fs.readFile(settingsPath, "utf-8")).replace(/^﻿/, ""));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			store = parsed;
		}
	} catch {
		// Missing or unreadable: start fresh.
	}
	if (store.controlServerEnabled === true) {
		return { settingsPath, changed: false };
	}
	store.controlServerEnabled = true;
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(store, null, 2), "utf-8");
	return { settingsPath, changed: true };
}

/**
 * Launches the Recordly executable with the control server enabled and waits
 * for the discovery file to appear.
 */
export async function launchRecordly({
	appPath = getDefaultRecordlyAppPath(),
	timeoutMs = 30_000,
	env = process.env,
	spawnImpl = spawn,
	clientOptions = {},
	persistSetting = true,
} = {}) {
	if (!appPath) {
		throw new Error(
			"Set RECORDLY_APP_PATH to the Recordly executable (or pass appPath) to launch it.",
		);
	}
	if (persistSetting) {
		try {
			await enableControlServerSetting(clientOptions);
		} catch {
			// Best effort; the --control-server flag below still enables it for this launch.
		}
	}
	// Never inherit ELECTRON_RUN_AS_NODE, or the app would start as a bare Node process.
	const { ELECTRON_RUN_AS_NODE: _ignored, ...childEnv } = env;
	const child = spawnImpl(appPath, ["--control-server"], {
		detached: true,
		stdio: "ignore",
		env: { ...childEnv, RECORDLY_CONTROL_SERVER: "1" },
	});
	child.unref();

	const startedAt = Date.now();
	let lastError = null;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const client = new RecordlyControlClient(clientOptions);
			const info = await client.connect();
			await client.call("ping", {}, { timeoutMs: 2_000 });
			return { pid: child.pid, info };
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	throw new Error(
		`Recordly did not expose its control server within ${timeoutMs}ms: ${lastError?.message ?? "unknown error"}`,
	);
}
