/**
 * Minimal JSON-RPC 2.0 framing for an MCP stdio server.
 *
 * MCP's stdio transport is newline-delimited JSON: one message per line, no
 * embedded newlines. This module has no dependencies so the MCP server can run
 * with plain Node.js and nothing installed.
 */

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export class JsonRpcError extends Error {
	constructor(code, message, data) {
		super(message);
		this.name = "JsonRpcError";
		this.code = code;
		this.data = data;
	}
}

/**
 * Splits a stream of text into complete lines, retaining a partial trailing
 * line in the returned `rest`.
 */
export function splitLines(buffer, chunk) {
	const combined = buffer + chunk;
	const lines = combined.split(/\r?\n/);
	const rest = lines.pop() ?? "";
	return { lines: lines.filter((line) => line.trim().length > 0), rest };
}

export function parseMessage(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new JsonRpcError(JSONRPC_PARSE_ERROR, "Parse error");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new JsonRpcError(JSONRPC_INVALID_REQUEST, "Invalid Request");
	}
	if (parsed.jsonrpc !== "2.0") {
		throw new JsonRpcError(JSONRPC_INVALID_REQUEST, 'Invalid Request: "jsonrpc" must be "2.0"');
	}
	return parsed;
}

export function isNotification(message) {
	return message.id === undefined || message.id === null;
}

export function successResponse(id, result) {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id, error) {
	const code = error instanceof JsonRpcError ? error.code : JSONRPC_INTERNAL_ERROR;
	const payload = { code, message: error?.message ?? String(error) };
	if (error instanceof JsonRpcError && error.data !== undefined) {
		payload.data = error.data;
	}
	return { jsonrpc: "2.0", id: id ?? null, error: payload };
}

export function serializeMessage(message) {
	return `${JSON.stringify(message)}\n`;
}

/**
 * Creates a dispatcher: `handlers[method](params, message)` returns the result.
 * Notifications (no id) never produce a response. Returns `null` when nothing
 * should be written back.
 */
export function createDispatcher(handlers) {
	return async function dispatch(line) {
		let message;
		try {
			message = parseMessage(line);
		} catch (error) {
			return errorResponse(null, error);
		}

		const notification = isNotification(message);
		const handler = handlers[message.method];
		if (typeof handler !== "function") {
			if (notification) {
				return null;
			}
			return errorResponse(
				message.id,
				new JsonRpcError(JSONRPC_METHOD_NOT_FOUND, `Method not found: ${message.method}`),
			);
		}

		try {
			const result = await handler(message.params ?? {}, message);
			if (notification) {
				return null;
			}
			return successResponse(message.id, result ?? {});
		} catch (error) {
			if (notification) {
				return null;
			}
			return errorResponse(message.id, error);
		}
	};
}
