/**
 * Output-path override used when an export is driven by automation (the
 * control server / MCP) instead of the save dialog. Mirrors the smoke-export
 * behaviour: when a fixed path is set, the finished file is written there
 * directly and no dialog is shown.
 */

let automationOutputPath: string | null = null;

export function setAutomationExportOutputPath(outputPath: string | null): void {
	automationOutputPath = outputPath;
}

export function getAutomationExportOutputPath(): string | null {
	return automationOutputPath;
}

export function resolveFixedExportOutputPath(config: {
	enabled: boolean;
	outputPath: string | null;
}): string | null {
	if (config.enabled && config.outputPath) {
		return config.outputPath;
	}
	return automationOutputPath;
}
