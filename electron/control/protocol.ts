/**
 * Pure helpers for the local control server (no Electron imports).
 *
 * The control server lets external automation (the Recordly MCP server, test
 * harnesses, scripts) drive the app over loopback HTTP. Everything here is
 * kept free of Electron so it can be unit tested.
 */

export const CONTROL_DISCOVERY_FILE_NAME = "control-server.json";
export const CONTROL_PROTOCOL_VERSION = 1;

export type ControlRequest = {
	method: string;
	params: Record<string, unknown>;
};

export type ControlDiscoveryInfo = {
	protocolVersion: number;
	port: number;
	token: string;
	pid: number;
	appVersion: string;
	startedAt: string;
};

export type ControlSourceSummary = {
	id: string;
	name: string;
	sourceType: "screen" | "window";
	appName?: string;
	windowTitle?: string;
	display_id?: string;
};

export class ControlError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "ControlError";
		this.code = code;
		this.status = status;
	}
}

export function isControlServerEnabled(input: {
	env: Record<string, string | undefined>;
	argv: readonly string[];
	appSetting: unknown;
}): boolean {
	const envValue = input.env["RECORDLY_CONTROL_SERVER"];
	if (envValue !== undefined) {
		return envValue === "1" || envValue.toLowerCase() === "true";
	}
	if (input.argv.includes("--control-server")) {
		return true;
	}
	if (input.argv.includes("--no-control-server")) {
		return false;
	}
	return input.appSetting === true;
}

export function parseControlRequest(rawBody: string): ControlRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		throw new ControlError("invalid_json", "Request body must be valid JSON.");
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ControlError("invalid_request", "Request body must be a JSON object.");
	}

	const { method, params } = parsed as { method?: unknown; params?: unknown };
	if (typeof method !== "string" || method.trim().length === 0) {
		throw new ControlError("invalid_request", 'Request must include a string "method".');
	}
	if (
		params !== undefined &&
		(params === null || typeof params !== "object" || Array.isArray(params))
	) {
		throw new ControlError("invalid_request", '"params" must be an object when provided.');
	}

	return {
		method: method.trim(),
		params: (params as Record<string, unknown> | undefined) ?? {},
	};
}

export function isAuthorizedRequest(
	authorizationHeader: string | string[] | undefined,
	expectedToken: string,
): boolean {
	if (!expectedToken) {
		return false;
	}
	const header = Array.isArray(authorizationHeader)
		? authorizationHeader[0]
		: authorizationHeader;
	if (typeof header !== "string") {
		return false;
	}
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) {
		return false;
	}
	return constantTimeEquals(match[1].trim(), expectedToken);
}

export function constantTimeEquals(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) {
		diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return diff === 0;
}

export function isLoopbackHost(hostHeader: string | undefined): boolean {
	if (!hostHeader) {
		return false;
	}
	const host = hostHeader.trim().toLowerCase();
	const withoutPort = host.startsWith("[")
		? host.slice(0, host.indexOf("]") + 1)
		: host.replace(/:\d+$/, "");
	return withoutPort === "127.0.0.1" || withoutPort === "localhost" || withoutPort === "[::1]";
}

function normalizeName(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Picks a capture source from a user-supplied query.
 *
 * Priority: exact id → exact name/title match → substring match on
 * name/title/app name. Screens are preferred over windows on ties so that
 * "Screen" style queries do not accidentally grab a window titled the same.
 */
export function matchControlSource<T extends ControlSourceSummary>(
	sources: readonly T[],
	query: { id?: unknown; name?: unknown; type?: unknown },
): T | null {
	const id = typeof query.id === "string" ? query.id.trim() : "";
	if (id) {
		return sources.find((source) => source.id === id) ?? null;
	}

	const type = query.type === "screen" || query.type === "window" ? (query.type as string) : null;
	const candidates = type ? sources.filter((source) => source.sourceType === type) : sources;

	const name = typeof query.name === "string" ? normalizeName(query.name) : "";
	if (!name) {
		if (type === "screen" || (!type && candidates.length > 0)) {
			return (
				candidates.find((source) => source.sourceType === "screen") ?? candidates[0] ?? null
			);
		}
		return candidates[0] ?? null;
	}

	const fields = (source: T) =>
		[source.name, source.windowTitle ?? "", source.appName ?? ""].map(normalizeName);

	const exact = candidates.filter((source) => fields(source).includes(name));
	if (exact.length > 0) {
		return exact.find((source) => source.sourceType === "screen") ?? exact[0];
	}

	const partial = candidates.filter((source) =>
		fields(source).some((field) => field.length > 0 && field.includes(name)),
	);
	if (partial.length > 0) {
		return partial.find((source) => source.sourceType === "screen") ?? partial[0];
	}

	return null;
}

/**
 * Like matchControlSource but returns every candidate in preference order, so
 * callers can fall back when the best match cannot be captured (for example a
 * minimized window with the same title as a visible one).
 */
export function matchControlSources<T extends ControlSourceSummary>(
	sources: readonly T[],
	query: { id?: unknown; name?: unknown; type?: unknown },
): T[] {
	const first = matchControlSource(sources, query);
	if (!first) {
		return [];
	}
	const id = typeof query.id === "string" ? query.id.trim() : "";
	if (id) {
		return [first];
	}
	const name = typeof query.name === "string" ? normalizeName(query.name) : "";
	const type = query.type === "screen" || query.type === "window" ? (query.type as string) : null;
	const candidates = sources.filter(
		(source) =>
			source !== first &&
			(!type || source.sourceType === type) &&
			(!name ||
				[source.name, source.windowTitle ?? "", source.appName ?? ""]
					.map(normalizeName)
					.some((field) => field.length > 0 && field.includes(name))),
	);
	return [first, ...candidates];
}

export function buildDiscoveryInfo(input: {
	port: number;
	token: string;
	pid: number;
	appVersion: string;
	now?: Date;
}): ControlDiscoveryInfo {
	return {
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		port: input.port,
		token: input.token,
		pid: input.pid,
		appVersion: input.appVersion,
		startedAt: (input.now ?? new Date()).toISOString(),
	};
}

export function readNumberParam(
	params: Record<string, unknown>,
	key: string,
	fallback: number,
	bounds?: { min?: number; max?: number },
): number {
	const raw = params[key];
	const value =
		typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
	if (!Number.isFinite(value)) {
		return fallback;
	}
	const min = bounds?.min ?? Number.NEGATIVE_INFINITY;
	const max = bounds?.max ?? Number.POSITIVE_INFINITY;
	return Math.min(max, Math.max(min, value));
}

export function readStringParam(params: Record<string, unknown>, key: string): string | null {
	const raw = params[key];
	return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

export function requireStringParam(params: Record<string, unknown>, key: string): string {
	const value = readStringParam(params, key);
	if (value === null) {
		throw new ControlError(
			"invalid_params",
			`"${key}" is required and must be a non-empty string.`,
		);
	}
	return value;
}
