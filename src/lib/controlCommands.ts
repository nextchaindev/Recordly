/**
 * Renderer-side registry for commands dispatched by the local control server.
 *
 * Windows register named handlers (for example the HUD registers
 * "recording.start"). The preload bridge invokes every registered handler in
 * turn; a handler returns CONTROL_UNHANDLED to pass on a command it does not
 * own.
 */

export const CONTROL_UNHANDLED = "__recordly_control_unhandled__";

export type ControlCommandHandlers = Record<
	string,
	(args: Record<string, unknown>) => Promise<unknown> | unknown
>;

export function registerControlCommands(handlers: ControlCommandHandlers): () => void {
	const bridge = window.electronAPI?.onControlCommand;
	if (typeof bridge !== "function") {
		return () => {
			// Not running inside Electron (tests / browser preview): nothing to unregister.
		};
	}
	return bridge(async (name, args) => {
		const handler = handlers[name];
		if (!handler) {
			return CONTROL_UNHANDLED;
		}
		const result = await handler(args);
		return result === undefined ? null : result;
	});
}
