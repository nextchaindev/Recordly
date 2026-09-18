import { describe, expect, it } from "vitest";
import {
	createDispatcher,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	JsonRpcError,
	serializeMessage,
	splitLines,
} from "./jsonrpc.mjs";

describe("splitLines", () => {
	it("returns complete lines and keeps the partial remainder", () => {
		const first = splitLines("", '{"a":1}\n{"b":');
		expect(first.lines).toEqual(['{"a":1}']);
		expect(first.rest).toBe('{"b":');
		const second = splitLines(first.rest, "2}\r\n\n");
		expect(second.lines).toEqual(['{"b":2}']);
		expect(second.rest).toBe("");
	});
});

describe("createDispatcher", () => {
	const dispatch = createDispatcher({
		ping: () => ({}),
		echo: (params) => params,
		boom: () => {
			throw new JsonRpcError(JSONRPC_INVALID_PARAMS, "bad params", { hint: "x" });
		},
		"notifications/initialized": () => {
			throw new Error("should be swallowed");
		},
	});

	it("answers requests with results", async () => {
		await expect(
			dispatch('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"x":1}}'),
		).resolves.toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { x: 1 },
		});
	});

	it("never answers notifications, even when they throw", async () => {
		await expect(
			dispatch('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
		).resolves.toBeNull();
		await expect(
			dispatch('{"jsonrpc":"2.0","method":"unknown/notification"}'),
		).resolves.toBeNull();
	});

	it("reports parse, method and handler errors", async () => {
		const parse = await dispatch("{not json");
		expect(parse.error.code).toBe(JSONRPC_PARSE_ERROR);
		expect(parse.id).toBeNull();

		const missing = await dispatch('{"jsonrpc":"2.0","id":"a","method":"nope"}');
		expect(missing.error.code).toBe(JSONRPC_METHOD_NOT_FOUND);
		expect(missing.id).toBe("a");

		const boom = await dispatch('{"jsonrpc":"2.0","id":2,"method":"boom"}');
		expect(boom.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: "bad params",
			data: { hint: "x" },
		});
	});

	it("rejects messages without jsonrpc 2.0", async () => {
		const result = await dispatch('{"id":1,"method":"ping"}');
		expect(result.error.message).toMatch(/jsonrpc/);
	});
});

describe("serializeMessage", () => {
	it("writes one line per message", () => {
		expect(serializeMessage({ jsonrpc: "2.0", id: 1, result: {} })).toBe(
			'{"jsonrpc":"2.0","id":1,"result":{}}\n',
		);
	});
});
