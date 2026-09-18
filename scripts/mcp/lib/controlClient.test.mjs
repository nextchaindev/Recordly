import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	enableControlServerSetting,
	getDefaultRecordlyAppPath,
	getDiscoveryFileCandidates,
	launchRecordly,
	parseDiscoveryInfo,
	RecordlyControlClient,
	readDiscoveryInfo,
} from "./controlClient.mjs";

describe("getDiscoveryFileCandidates", () => {
	it("prefers an explicit override", () => {
		expect(
			getDiscoveryFileCandidates({
				platform: "win32",
				env: { RECORDLY_CONTROL_FILE: "D:/x/control.json" },
				homeDir: "C:/Users/me",
			}),
		).toEqual(["D:/x/control.json"]);
	});

	it("uses APPDATA on Windows for the packaged and dev app", () => {
		const candidates = getDiscoveryFileCandidates({
			platform: "win32",
			env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
			homeDir: "C:\\Users\\me",
		});
		expect(candidates).toEqual([
			path.join("C:\\Users\\me\\AppData\\Roaming", "Recordly", "control-server.json"),
			path.join("C:\\Users\\me\\AppData\\Roaming", "Recordly-dev", "control-server.json"),
		]);
	});

	it("uses Application Support on macOS and XDG config on Linux", () => {
		expect(
			getDiscoveryFileCandidates({ platform: "darwin", env: {}, homeDir: "/Users/me" })[0],
		).toBe(path.join("/Users/me/Library/Application Support/Recordly/control-server.json"));
		expect(
			getDiscoveryFileCandidates({
				platform: "linux",
				env: { XDG_CONFIG_HOME: "/tmp/cfg" },
				homeDir: "/home/me",
			})[0],
		).toBe(path.join("/tmp/cfg/Recordly/control-server.json"));
	});
});

describe("getDefaultRecordlyAppPath", () => {
	it("prefers RECORDLY_APP_PATH, then the Electron executable in run-as-node mode", () => {
		expect(
			getDefaultRecordlyAppPath({
				env: { RECORDLY_APP_PATH: "C:/R.exe", ELECTRON_RUN_AS_NODE: "1" },
				execPath: "C:/Recordly.exe",
				versions: { electron: "43.0.0" },
			}),
		).toBe("C:/R.exe");
		expect(
			getDefaultRecordlyAppPath({
				env: { ELECTRON_RUN_AS_NODE: "1" },
				execPath: "C:/Recordly.exe",
				versions: { electron: "43.0.0" },
			}),
		).toBe("C:/Recordly.exe");
		expect(
			getDefaultRecordlyAppPath({
				env: {},
				execPath: "C:/node.exe",
				versions: {},
				exists: () => false,
			}),
		).toBeUndefined();
		const installed = path.join(
			"C:\\Users\\me\\AppData\\Local",
			"Programs",
			"Recordly",
			"Recordly.exe",
		);
		expect(
			getDefaultRecordlyAppPath({
				env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
				execPath: "C:/node.exe",
				versions: {},
				platform: "win32",
				exists: (candidate) => candidate === installed,
			}),
		).toBe(installed);
	});
});

describe("enableControlServerSetting", () => {
	it("adds controlServerEnabled without dropping other settings", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-settings-"));
		try {
			const userData = path.join(tempDir, "Recordly");
			await fs.mkdir(userData, { recursive: true });
			await fs.writeFile(path.join(userData, "app-settings.json"), '{"theme":"dark"}');
			const first = await enableControlServerSetting({
				platform: "win32",
				env: { APPDATA: tempDir },
				homeDir: tempDir,
			});
			expect(first.changed).toBe(true);
			expect(JSON.parse(await fs.readFile(first.settingsPath, "utf-8"))).toEqual({
				theme: "dark",
				controlServerEnabled: true,
			});
			const second = await enableControlServerSetting({
				platform: "win32",
				env: { APPDATA: tempDir },
				homeDir: tempDir,
			});
			expect(second.changed).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("launchRecordly", () => {
	it("spawns the app with --control-server and without ELECTRON_RUN_AS_NODE", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-launch-"));
		try {
			const filePath = path.join(tempDir, "control-server.json");
			let spawned = null;
			const promise = launchRecordly({
				appPath: "C:/Recordly.exe",
				timeoutMs: 5_000,
				env: { ELECTRON_RUN_AS_NODE: "1", PATH: "x" },
				persistSetting: false,
				clientOptions: {
					env: { RECORDLY_CONTROL_FILE: filePath },
					fetch: async () => ({
						status: 200,
						json: async () => ({ ok: true, result: {} }),
					}),
				},
				spawnImpl: (command, args, options) => {
					spawned = { command, args, options };
					return {
						pid: 123,
						unref() {
							// detached child stub
						},
					};
				},
			});
			await fs.writeFile(filePath, JSON.stringify({ port: 1, token: "t", pid: process.pid }));
			const result = await promise;
			expect(result.pid).toBe(123);
			expect(spawned.command).toBe("C:/Recordly.exe");
			expect(spawned.args).toEqual(["--control-server"]);
			expect(spawned.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
			expect(spawned.options.env.RECORDLY_CONTROL_SERVER).toBe("1");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("parseDiscoveryInfo", () => {
	it("requires port and token", () => {
		expect(parseDiscoveryInfo('{"port":1234,"token":"abc"}')).toEqual({
			port: 1234,
			token: "abc",
		});
		expect(() => parseDiscoveryInfo('{"port":"1234"}')).toThrow(/malformed/);
	});
});

describe("readDiscoveryInfo / RecordlyControlClient", () => {
	let tempDir;
	let filePath;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-mcp-client-"));
		filePath = path.join(tempDir, "control-server.json");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("reads a live discovery file", async () => {
		await fs.writeFile(
			filePath,
			JSON.stringify({ port: 4567, token: "tok", pid: process.pid }),
		);
		const info = await readDiscoveryInfo({ env: { RECORDLY_CONTROL_FILE: filePath } });
		expect(info.port).toBe(4567);
		expect(info.filePath).toBe(filePath);
	});

	it("explains how to enable the server when nothing is found", async () => {
		await expect(
			readDiscoveryInfo({
				env: { RECORDLY_CONTROL_FILE: path.join(tempDir, "missing.json") },
			}),
		).rejects.toThrow(/RECORDLY_CONTROL_SERVER=1/);
	});

	it("sends bearer-authenticated JSON-RPC style calls and unwraps results", async () => {
		await fs.writeFile(
			filePath,
			JSON.stringify({ port: 4567, token: "tok", pid: process.pid }),
		);
		const seen = [];
		const client = new RecordlyControlClient({
			env: { RECORDLY_CONTROL_FILE: filePath },
			fetch: async (url, init) => {
				seen.push({ url, init });
				return {
					status: 200,
					json: async () => ({ ok: true, result: { recording: false } }),
				};
			},
		});
		await expect(client.call("status", { a: 1 })).resolves.toEqual({ recording: false });
		expect(seen[0].url).toBe("http://127.0.0.1:4567/rpc");
		expect(seen[0].init.headers.Authorization).toBe("Bearer tok");
		expect(JSON.parse(seen[0].init.body)).toEqual({ method: "status", params: { a: 1 } });
	});

	it("surfaces control server errors with their code", async () => {
		await fs.writeFile(
			filePath,
			JSON.stringify({ port: 4567, token: "tok", pid: process.pid }),
		);
		const client = new RecordlyControlClient({
			env: { RECORDLY_CONTROL_FILE: filePath },
			fetch: async () => ({
				status: 404,
				json: async () => ({
					ok: false,
					error: { code: "source_not_found", message: "No capture source matched." },
				}),
			}),
		});
		await expect(client.call("sources.select", { name: "x" })).rejects.toThrow(
			/No capture source matched\. \(source_not_found\)/,
		);
	});
});
