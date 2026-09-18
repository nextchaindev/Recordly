import { type RefObject, useEffect, useRef } from "react";
import { registerControlCommands } from "@/lib/controlCommands";
import { setAutomationExportOutputPath } from "@/lib/exportAutomation";
import type {
	ExportEncodingMode,
	ExportMp4FrameRate,
	ExportQuality,
	ExportSettings,
} from "@/lib/exporter/types";
import type { useExportSettings } from "../export/useExportSettings";
import type { useAppearanceState } from "../state/useAppearanceState";
import type { CropRegion, Padding } from "../types";
import type { VideoPlaybackRef } from "../VideoPlayback";

type EditorControlInput = {
	videoPath: string | null;
	loading: boolean;
	error: string | null;
	isPreviewReady: boolean;
	duration: number;
	aspectRatio: string;
	setAspectRatio: (value: never) => void;
	appearance: ReturnType<typeof useAppearanceState>;
	exportSettings: ReturnType<typeof useExportSettings>;
	setSessionShowCursorOverride: (value: boolean | null) => void;
	videoPlaybackRef: RefObject<VideoPlaybackRef>;
	handleExport: (settings: ExportSettings) => Promise<void>;
};

const READY_TIMEOUT_MS = 60_000;

function isQuality(value: unknown): value is ExportQuality {
	return value === "medium" || value === "good" || value === "high" || value === "source";
}

function isEncodingMode(value: unknown): value is ExportEncodingMode {
	return value === "fast" || value === "balanced" || value === "quality";
}

function toPadding(value: unknown): Padding | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		const size = Math.max(0, value);
		return { top: size, bottom: size, left: size, right: size, linked: true };
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const read = (key: string) =>
			typeof record[key] === "number" && Number.isFinite(record[key])
				? Math.max(0, record[key] as number)
				: 0;
		return {
			top: read("top"),
			bottom: read("bottom"),
			left: read("left"),
			right: read("right"),
			linked: false,
		};
	}
	return null;
}

function toCropRegion(value: unknown): CropRegion | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const numbers = ["x", "y", "width", "height"].map((key) => record[key]);
	if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
		return null;
	}
	const [x, y, width, height] = numbers as number[];
	if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > 1 || y + height > 1) {
		return null;
	}
	return { x, y, width, height };
}

/**
 * Lets the control server drive the editor: inspect readiness and run an
 * export with explicit framing (crop, padding, background, aspect, cursor)
 * straight to a file, with no save dialog. This is how automation gets
 * Recordly's rendered cursor and exact output size instead of the raw capture.
 */
export function useEditorControlCommands(input: EditorControlInput) {
	const latest = useRef(input);
	latest.current = input;

	useEffect(() => {
		const snapshot = () => {
			const current = latest.current;
			const video = current.videoPlaybackRef.current?.video ?? null;
			return {
				videoPath: current.videoPath,
				loading: current.loading,
				error: current.error,
				isPreviewReady: current.isPreviewReady,
				duration: current.duration,
				aspectRatio: current.aspectRatio,
				sourceWidth: video?.videoWidth ?? null,
				sourceHeight: video?.videoHeight ?? null,
				padding: current.appearance.padding,
				cropRegion: current.appearance.cropRegion,
				wallpaper: current.appearance.wallpaper,
				showCursor: current.appearance.showCursor,
			};
		};

		const waitUntilReady = async () => {
			const startedAt = Date.now();
			while (Date.now() - startedAt < READY_TIMEOUT_MS) {
				const current = latest.current;
				if (current.error) {
					throw new Error(`Editor failed to load the recording: ${current.error}`);
				}
				const video = current.videoPlaybackRef.current?.video ?? null;
				if (
					current.videoPath &&
					!current.loading &&
					current.isPreviewReady &&
					current.duration > 0 &&
					video &&
					video.videoHeight > 0
				) {
					return video;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			throw new Error("Editor did not become ready within 60s.");
		};

		return registerControlCommands({
			"editor.state": () => snapshot(),
			"editor.export": async (args) => {
				const outputPath =
					typeof args.outputPath === "string" ? args.outputPath.trim() : "";
				if (!outputPath) {
					throw new Error('"outputPath" is required.');
				}
				const video = await waitUntilReady();
				const current = latest.current;
				const { appearance, exportSettings } = current;

				if (typeof args.aspectRatio === "string") {
					current.setAspectRatio(args.aspectRatio as never);
				}
				const padding = toPadding(args.padding);
				if (padding) {
					appearance.setPadding(padding);
				}
				if (typeof args.background === "string" && args.background) {
					appearance.setWallpaper(args.background);
				}
				if (typeof args.borderRadius === "number") {
					appearance.setBorderRadius(Math.max(0, args.borderRadius));
				}
				if (typeof args.shadow === "number") {
					appearance.setShadowIntensity(Math.max(0, Math.min(1, args.shadow)));
				}
				if (typeof args.showCursor === "boolean") {
					appearance.setShowCursor(args.showCursor);
					current.setSessionShowCursorOverride(args.showCursor);
				}
				const explicitCrop = toCropRegion(args.crop);
				if (explicitCrop) {
					appearance.setCropRegion(explicitCrop);
				} else {
					const cropTop =
						typeof args.cropTop === "number" ? Math.max(0, args.cropTop) : 0;
					const cropBottom =
						typeof args.cropBottom === "number" ? Math.max(0, args.cropBottom) : 0;
					if (cropTop > 0 || cropBottom > 0) {
						const height = video.videoHeight;
						const y = Math.min(0.9, cropTop / height);
						const bottom = Math.min(0.9, cropBottom / height);
						appearance.setCropRegion({
							x: 0,
							y,
							width: 1,
							height: Math.max(0.05, 1 - y - bottom),
						});
					} else if (args.resetCrop === true) {
						appearance.setCropRegion({ x: 0, y: 0, width: 1, height: 1 });
					}
				}
				const quality = isQuality(args.quality) ? args.quality : "source";
				exportSettings.setExportQuality(quality);
				exportSettings.setExportFormat("mp4");
				const fps =
					typeof args.fps === "number" && Number.isFinite(args.fps)
						? (Math.round(args.fps) as ExportMp4FrameRate)
						: undefined;
				if (fps !== undefined) {
					exportSettings.setMp4FrameRate(fps);
				}
				const encodingMode = isEncodingMode(args.encodingMode)
					? args.encodingMode
					: "balanced";

				// Let React apply the state updates before the runner reads them.
				await new Promise((resolve) => setTimeout(resolve, 350));

				setAutomationExportOutputPath(outputPath);
				try {
					await latest.current.handleExport({
						format: "mp4",
						quality,
						encodingMode,
						...(fps !== undefined ? { mp4FrameRate: fps } : {}),
					});
				} finally {
					setAutomationExportOutputPath(null);
				}
				return { outputPath, ...snapshot() };
			},
		});
	}, []);
}
