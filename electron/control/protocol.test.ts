import { describe, expect, it } from "vitest";
import {
	buildDiscoveryInfo,
	ControlError,
	isAuthorizedRequest,
	isControlServerEnabled,
	isLoopbackHost,
	matchControlSource,
	matchControlSources,
	parseControlRequest,
	readNumberParam,
	requireStringParam,
} from "./protocol";

describe("isControlServerEnabled", () => {
	it("is off by default", () => {
		expect(isControlServerEnabled({ env: {}, argv: [], appSetting: null })).toBe(false);
	});

	it("honours the env var over everything else", () => {
		expect(
			isControlServerEnabled({
				env: { RECORDLY_CONTROL_SERVER: "1" },
				argv: [],
				appSetting: false,
			}),
		).toBe(true);
		expect(
			isControlServerEnabled({
				env: { RECORDLY_CONTROL_SERVER: "0" },
				argv: ["--control-server"],
				appSetting: true,
			}),
		).toBe(false);
	});

	it("accepts the CLI flag and the app setting", () => {
		expect(
			isControlServerEnabled({ env: {}, argv: ["--control-server"], appSetting: null }),
		).toBe(true);
		expect(isControlServerEnabled({ env: {}, argv: [], appSetting: true })).toBe(true);
		expect(
			isControlServerEnabled({ env: {}, argv: ["--no-control-server"], appSetting: true }),
		).toBe(false);
	});
});

describe("parseControlRequest", () => {
	it("parses method and params", () => {
		expect(parseControlRequest('{"method":" status ","params":{"a":1}}')).toEqual({
			method: "status",
			params: { a: 1 },
		});
		expect(parseControlRequest('{"method":"ping"}')).toEqual({ method: "ping", params: {} });
	});

	it("rejects malformed bodies", () => {
		expect(() => parseControlRequest("nope")).toThrow(ControlError);
		expect(() => parseControlRequest("[]")).toThrow(/JSON object/);
		expect(() => parseControlRequest('{"params":{}}')).toThrow(/method/);
		expect(() => parseControlRequest('{"method":"x","params":[]}')).toThrow(/params/);
	});
});

describe("isAuthorizedRequest", () => {
	it("requires a matching bearer token", () => {
		expect(isAuthorizedRequest("Bearer abc", "abc")).toBe(true);
		expect(isAuthorizedRequest("bearer abc", "abc")).toBe(true);
		expect(isAuthorizedRequest(["Bearer abc"], "abc")).toBe(true);
		expect(isAuthorizedRequest("Bearer abd", "abc")).toBe(false);
		expect(isAuthorizedRequest("abc", "abc")).toBe(false);
		expect(isAuthorizedRequest(undefined, "abc")).toBe(false);
		expect(isAuthorizedRequest("Bearer ", "")).toBe(false);
	});
});

describe("isLoopbackHost", () => {
	it("accepts loopback hosts only", () => {
		expect(isLoopbackHost("127.0.0.1:5123")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("[::1]:80")).toBe(true);
		expect(isLoopbackHost("example.com:5123")).toBe(false);
		expect(isLoopbackHost("192.168.0.2:5123")).toBe(false);
		expect(isLoopbackHost(undefined)).toBe(false);
	});
});

describe("matchControlSource", () => {
	const sources = [
		{ id: "screen:1:0", name: "Primary Display", sourceType: "screen" as const },
		{ id: "screen:2:0", name: "Display 2", sourceType: "screen" as const },
		{
			id: "window:10:0",
			name: "preview.html - Chrome",
			sourceType: "window" as const,
			appName: "Google Chrome",
			windowTitle: "preview.html",
		},
		{
			id: "window:11:0",
			name: "Cursor",
			sourceType: "window" as const,
			appName: "Cursor",
			windowTitle: "index.html - 연습 - Cursor",
		},
	];

	it("matches by exact id first", () => {
		expect(matchControlSource(sources, { id: "window:11:0" })?.name).toBe("Cursor");
		expect(matchControlSource(sources, { id: "window:99:0", name: "Cursor" })).toBeNull();
	});

	it("prefers the primary screen when nothing specific is asked", () => {
		expect(matchControlSource(sources, {})?.id).toBe("screen:1:0");
		expect(matchControlSource(sources, { type: "screen" })?.id).toBe("screen:1:0");
		expect(matchControlSource(sources, { type: "window" })?.id).toBe("window:10:0");
	});

	it("matches window titles and app names case-insensitively", () => {
		expect(matchControlSource(sources, { name: "cursor" })?.id).toBe("window:11:0");
		expect(matchControlSource(sources, { name: "PREVIEW" })?.id).toBe("window:10:0");
		expect(matchControlSource(sources, { name: "google chrome" })?.id).toBe("window:10:0");
		expect(matchControlSource(sources, { name: "연습" })?.id).toBe("window:11:0");
	});

	it("restricts to the requested type", () => {
		expect(matchControlSource(sources, { name: "Display 2", type: "window" })).toBeNull();
		expect(matchControlSource(sources, { name: "Display 2", type: "screen" })?.id).toBe(
			"screen:2:0",
		);
	});

	it("returns null when nothing matches", () => {
		expect(matchControlSource(sources, { name: "Slack" })).toBeNull();
	});
});

describe("param helpers", () => {
	it("reads bounded numbers with fallbacks", () => {
		expect(readNumberParam({ n: 5 }, "n", 1)).toBe(5);
		expect(readNumberParam({ n: "7" }, "n", 1)).toBe(7);
		expect(readNumberParam({ n: "x" }, "n", 1)).toBe(1);
		expect(readNumberParam({}, "n", 1)).toBe(1);
		expect(readNumberParam({ n: 999 }, "n", 1, { max: 10 })).toBe(10);
		expect(readNumberParam({ n: -5 }, "n", 1, { min: 0 })).toBe(0);
	});

	it("requires non-empty strings", () => {
		expect(requireStringParam({ text: "hi" }, "text")).toBe("hi");
		expect(() => requireStringParam({ text: "  " }, "text")).toThrow(ControlError);
		expect(() => requireStringParam({}, "text")).toThrow(/required/);
	});
});

describe("matchControlSources", () => {
	const sources = [
		{ id: "screen:1:0", name: "Primary Display", sourceType: "screen" as const },
		{
			id: "window:1:0",
			name: "ChatGPT",
			sourceType: "window" as const,
			windowTitle: "ChatGPT",
		},
		{
			id: "window:2:0",
			name: "ChatGPT",
			sourceType: "window" as const,
			windowTitle: "ChatGPT",
		},
		{ id: "window:3:0", name: "Cursor", sourceType: "window" as const, windowTitle: "Cursor" },
	];

	it("returns every window sharing the queried title, best match first", () => {
		expect(
			matchControlSources(sources, { name: "chatgpt", type: "window" }).map((s) => s.id),
		).toEqual(["window:1:0", "window:2:0"]);
	});

	it("returns only the exact id match when an id is given", () => {
		expect(matchControlSources(sources, { id: "window:2:0" }).map((s) => s.id)).toEqual([
			"window:2:0",
		]);
	});

	it("returns an empty list when nothing matches", () => {
		expect(matchControlSources(sources, { name: "Slack" })).toEqual([]);
	});
});

describe("buildDiscoveryInfo", () => {
	it("captures port, token, pid and version", () => {
		const info = buildDiscoveryInfo({
			port: 4321,
			token: "t",
			pid: 42,
			appVersion: "1.4.0",
			now: new Date("2026-09-18T00:00:00Z"),
		});
		expect(info).toEqual({
			protocolVersion: 1,
			port: 4321,
			token: "t",
			pid: 42,
			appVersion: "1.4.0",
			startedAt: "2026-09-18T00:00:00.000Z",
		});
	});
});
