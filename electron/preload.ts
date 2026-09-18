import { contextBridge, ipcRenderer } from "electron";
import type { RecordingSessionData } from "./ipc/types";

type NativeVideoExportWriteResult = { success: boolean; error?: string };
type NativeVideoAudioMuxMetrics = {
	tempVideoWriteMs?: number;
	tempEditedAudioWriteMs?: number;
	ffmpegExecMs?: number;
	muxedVideoReadMs?: number;
	tempVideoBytes?: number;
	tempEditedAudioBytes?: number;
	muxedVideoBytes?: number;
};
type WindowsGpuExportSummary = {
	success?: boolean;
	width?: number;
	height?: number;
	fps?: number;
	seconds?: number;
	mediaMs?: number;
	frames?: number;
	cursorOverlay?: boolean;
	zoomOverlay?: boolean;
	adapterVendorId?: number;
	adapterDeviceId?: number;
	adapterDedicatedVideoMemoryMB?: number;
	initializeMs?: number;
	initCoInitializeMs?: number;
	initMfStartupMs?: number;
	initD3DDeviceMs?: number;
	initSourceReaderMs?: number;
	initWebcamReaderMs?: number;
	initVideoProcessorMs?: number;
	initTexturesMs?: number;
	initShaderPipelineMs?: number;
	initSinkWriterMs?: number;
	totalMs?: number;
	readMs?: number;
	clearMs?: number;
	videoProcessMs?: number;
	writeSampleMs?: number;
	finalizeMs?: number;
	realtimeMultiplier?: number;
};
type NativeStaticLayoutChunkMetric = {
	index: number;
	startSec: number;
	durationSec: number;
	backend:
		| "cuda-overlay"
		| "cuda-scale-cpu-pad"
		| "cuda-static-composite"
		| "nvidia-cuda-compositor"
		| "windows-d3d11-compositor";
	elapsedMs: number;
	outputBytes: number;
	fallbackReason?: string;
	windowsGpuSummary?: WindowsGpuExportSummary;
};
type NativeStaticLayoutMetrics = NativeVideoAudioMuxMetrics & {
	chunkCount: number;
	chunkDurationSec: number;
	chunkExecMs: number;
	concatExecMs?: number;
	staticAssetExecMs?: number;
	fallbackChunkCount: number;
	videoOnlyBytes?: number;
	chunks: NativeStaticLayoutChunkMetric[];
};
type NativeStaticLayoutProgress = {
	sessionId?: string;
	backend?: NativeStaticLayoutChunkMetric["backend"];
	stage?: "preparing" | "finalizing";
	elapsedMs?: number;
	averageFps?: number;
	currentFrame: number;
	totalFrames: number;
	percentage: number;
};
type NativeVideoMetadataProbe = {
	width: number;
	height: number;
	duration: number;
	mediaStartTime?: number;
	streamStartTime?: number;
	streamDuration?: number;
	frameRate: number;
	codec: string;
	hasAudio: boolean;
	audioCodec?: string;
	audioSampleRate?: number;
};
type NativeExportCapabilities = {
	platform: NodeJS.Platform;
	nvidiaCuda: {
		available: boolean;
		skipReason: string | null;
		hasNvidiaGpu: boolean | null;
		hasWrapper: boolean;
		explicitEnabled: boolean;
		explicitDisabled: boolean;
		userOptInRequired: boolean;
	};
};
type ExportHardwareInfo = {
	platform: NodeJS.Platform;
	release: string;
	arch: string;
	cpuModel: string | null;
	logicalProcessors: number;
	totalMemoryGb: number;
	machineModel: string | null;
	gpus: Array<{
		name: string;
		vendor: string | null;
		active: boolean | null;
	}>;
	gpuFeatures: {
		videoDecode: string | null;
		videoEncode: string | null;
		webgl: string | null;
		webgpu: string | null;
	};
};

const nativeVideoExportWriteRequests = new Map<
	number,
	{
		sessionId: string;
		resolve: (result: NativeVideoExportWriteResult) => void;
	}
>();

let nextNativeVideoExportWriteRequestId = 1;
let nativeVideoExportWriteResultListenerAttached = false;

function ensureNativeVideoExportWriteResultListener() {
	if (nativeVideoExportWriteResultListenerAttached) {
		return;
	}

	nativeVideoExportWriteResultListenerAttached = true;
	ipcRenderer.on(
		"native-video-export-write-frame-result",
		(
			_event,
			payload: {
				sessionId?: string;
				requestId?: number;
				success?: boolean;
				error?: string;
			},
		) => {
			if (typeof payload?.requestId !== "number") {
				return;
			}

			const pendingRequest = nativeVideoExportWriteRequests.get(payload.requestId);
			if (!pendingRequest) {
				return;
			}

			nativeVideoExportWriteRequests.delete(payload.requestId);
			pendingRequest.resolve({
				success: payload.success === true,
				error: payload.error,
			});
		},
	);
}

function settleNativeVideoExportPendingRequests(
	sessionId: string,
	result: NativeVideoExportWriteResult,
) {
	for (const [requestId, pendingRequest] of nativeVideoExportWriteRequests.entries()) {
		if (pendingRequest.sessionId !== sessionId) {
			continue;
		}

		nativeVideoExportWriteRequests.delete(requestId);
		pendingRequest.resolve(result);
	}
}

contextBridge.exposeInMainWorld("electronAPI", {
	hudOverlaySetIgnoreMouse: (ignore: boolean) => {
		ipcRenderer.send("hud-overlay-set-ignore-mouse", ignore);
	},
	hudOverlaySetSourceSelectionActive: (active: boolean) => {
		ipcRenderer.send("hud-overlay-set-source-selection-active", active);
	},
	hudOverlayDrag: (phase: "start" | "move" | "end", screenX: number, screenY: number) => {
		ipcRenderer.send("hud-overlay-drag", phase, screenX, screenY);
	},
	hudOverlayHide: () => {
		ipcRenderer.send("hud-overlay-hide");
	},
	hudOverlayClose: () => {
		ipcRenderer.send("hud-overlay-close");
	},
	hudOverlayRendererReady: () => {
		ipcRenderer.send("hud-overlay-renderer-ready");
	},
	hudOverlaySetWebcamPreviewVisible: (visible: boolean) => {
		ipcRenderer.send("hud-overlay-set-webcam-preview-visible", visible);
	},
	getHudOverlayCaptureProtection: () => {
		return ipcRenderer.invoke("get-hud-overlay-capture-protection");
	},
	getHudOverlayMousePassthroughSupported: () => {
		return ipcRenderer.invoke("get-hud-overlay-mouse-passthrough-supported");
	},
	setHudOverlayCaptureProtection: (enabled: boolean) => {
		return ipcRenderer.invoke("set-hud-overlay-capture-protection", enabled);
	},
	getAssetBasePath: async () => {
		return await ipcRenderer.invoke("get-asset-base-path");
	},
	listAssetDirectory: (relativeDir: string) => {
		return ipcRenderer.invoke("list-asset-directory", relativeDir);
	},
	readLocalFile: (filePath: string) => {
		return ipcRenderer.invoke("read-local-file", filePath);
	},
	generateWallpaperThumbnail: (filePath: string) => {
		return ipcRenderer.invoke("generate-wallpaper-thumbnail", filePath);
	},
	probeNativeVideoMetadata: (filePath: string) => {
		return ipcRenderer.invoke("probe-native-video-metadata", filePath) as Promise<{
			success: boolean;
			metadata?: NativeVideoMetadataProbe;
			error?: string;
		}>;
	},
	getNativeExportCapabilities: () => {
		return ipcRenderer.invoke("get-native-export-capabilities") as Promise<{
			success: boolean;
			capabilities?: NativeExportCapabilities;
			error?: string;
		}>;
	},
	getExportHardwareInfo: () => {
		return ipcRenderer.invoke("get-export-hardware-info") as Promise<{
			success: boolean;
			hardware?: ExportHardwareInfo;
			error?: string;
		}>;
	},
	nativeStaticLayoutExport: (options: {
		sessionId?: string;
		inputPath: string;
		width: number;
		height: number;
		frameRate: number;
		bitrate: number;
		encodingMode: "fast" | "balanced" | "quality";
		durationSec: number;
		contentWidth: number;
		contentHeight: number;
		offsetX: number;
		offsetY: number;
		sourceCropX?: number;
		sourceCropY?: number;
		sourceCropWidth?: number;
		sourceCropHeight?: number;
		backgroundColor: string;
		backgroundImagePath?: string | null;
		backgroundBlurPx?: number;
		borderRadius?: number;
		shadowIntensity?: number;
		webcamInputPath?: string | null;
		webcamLeft?: number;
		webcamTop?: number;
		webcamSize?: number;
		webcamRadius?: number;
		webcamShadowIntensity?: number;
		webcamMirror?: boolean;
		webcamTimeOffsetMs?: number;
		cursorTelemetry?: Array<{
			timeMs: number;
			cx: number;
			cy: number;
			cursorTypeIndex?: number;
			bounceScale?: number;
			visible?: boolean;
		}>;
		cursorSize?: number;
		cursorAtlasPngDataUrl?: string | null;
		cursorAtlasEntries?: Array<{
			index: number;
			x: number;
			y: number;
			width: number;
			height: number;
			anchorX: number;
			anchorY: number;
			aspectRatio: number;
		}>;
		zoomTelemetry?: Array<{ timeMs: number; scale: number; x: number; y: number }>;
		timelineSegments?: Array<{
			sourceStartMs: number;
			sourceEndMs: number;
			outputStartMs: number;
			outputEndMs: number;
			speed: number;
		}>;
		chunkDurationSec?: number;
		experimentalWindowsGpuCompositor?: boolean;
		experimentalNvidiaCudaExport?: boolean;
		audioOptions?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		};
	}) => {
		return ipcRenderer.invoke("native-static-layout-export", options) as Promise<{
			success: boolean;
			tempPath?: string;
			encoderName?: string;
			error?: string;
			metrics?: NativeStaticLayoutMetrics;
		}>;
	},
	nativeStaticLayoutExportCancel: (sessionId: string) => {
		return ipcRenderer.invoke("native-static-layout-export-cancel", sessionId) as Promise<{
			success: boolean;
		}>;
	},
	onNativeStaticLayoutExportProgress: (
		callback: (progress: NativeStaticLayoutProgress) => void,
	) => {
		const listener = (_event: Electron.IpcRendererEvent, payload: NativeStaticLayoutProgress) =>
			callback(payload);
		ipcRenderer.on("native-static-layout-export-progress", listener);
		return () => ipcRenderer.removeListener("native-static-layout-export-progress", listener);
	},
	nativeVideoExportStart: (options: {
		width: number;
		height: number;
		frameRate: number;
		bitrate: number;
		encodingMode: "fast" | "balanced" | "quality";
		inputMode?: "rawvideo" | "h264-stream";
	}) => {
		return ipcRenderer.invoke("native-video-export-start", options);
	},
	nativeVideoExportWriteFrame: (sessionId: string, frameData: Uint8Array) => {
		ensureNativeVideoExportWriteResultListener();

		return new Promise<NativeVideoExportWriteResult>((resolve) => {
			const requestId = nextNativeVideoExportWriteRequestId++;
			nativeVideoExportWriteRequests.set(requestId, {
				sessionId,
				resolve,
			});

			ipcRenderer.send("native-video-export-write-frame-async", {
				sessionId,
				requestId,
				frameData,
			});
		});
	},
	nativeVideoExportWriteFrames: (sessionId: string, frameDataList: Uint8Array[]) => {
		ensureNativeVideoExportWriteResultListener();

		return new Promise<NativeVideoExportWriteResult>((resolve) => {
			const requestId = nextNativeVideoExportWriteRequestId++;
			nativeVideoExportWriteRequests.set(requestId, {
				sessionId,
				resolve,
			});

			ipcRenderer.send("native-video-export-write-frames-async", {
				sessionId,
				requestId,
				frameDataList,
			});
		});
	},
	nativeVideoExportFinish: (
		sessionId: string,
		options?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		},
	) => {
		return ipcRenderer
			.invoke("native-video-export-finish", sessionId, options)
			.then((result) => {
				settleNativeVideoExportPendingRequests(
					sessionId,
					result?.success
						? { success: true }
						: {
								success: false,
								error:
									typeof result?.error === "string"
										? result.error
										: "Native video export session finished before all frame writes settled.",
							},
				);

				return result;
			}) as Promise<{
			success: boolean;
			data?: Uint8Array;
			encoderName?: string;
			error?: string;
			metrics?: NativeVideoAudioMuxMetrics;
		}>;
	},
	nativeVideoExportCancel: (sessionId: string) => {
		return ipcRenderer.invoke("native-video-export-cancel", sessionId).finally(() => {
			settleNativeVideoExportPendingRequests(sessionId, {
				success: false,
				error: "Native video export session was cancelled",
			});
		});
	},
	muxExportedVideoAudio: (
		videoData: ArrayBuffer,
		options?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		},
	) => {
		return ipcRenderer.invoke("mux-exported-video-audio", videoData, options) as Promise<{
			success: boolean;
			tempPath?: string;
			error?: string;
			metrics?: NativeVideoAudioMuxMetrics;
		}>;
	},
	muxExportedVideoAudioFromPath: (
		videoPath: string,
		options?: {
			audioMode?: "none" | "copy-source" | "trim-source" | "edited-track";
			audioSourcePath?: string | null;
			audioSourceCodec?: string | null;
			audioSourceSampleRate?: number;
			outputDurationSec?: number;
			trimSegments?: Array<{ startMs: number; endMs: number }>;
			editedTrackStrategy?: "filtergraph-fast-path" | "offline-render-fallback";
			editedTrackSegments?: Array<{ startMs: number; endMs: number; speed: number }>;
			editedAudioData?: ArrayBuffer;
			editedAudioMimeType?: string | null;
		},
	) => {
		return ipcRenderer.invoke("mux-exported-video-audio-from-path", videoPath, options);
	},
	openExportStream: (options?: { extension?: string }) => {
		return ipcRenderer.invoke("export-stream-open", options);
	},
	writeExportStreamChunk: (streamId: string, position: number, chunk: Uint8Array) => {
		return ipcRenderer.invoke("export-stream-write", streamId, position, chunk);
	},
	closeExportStream: (streamId: string, options?: { abort?: boolean }) => {
		return ipcRenderer.invoke("export-stream-close", streamId, options);
	},
	finalizeExportedVideo: (payload: {
		tempPath: string;
		fileName: string;
		outputPath?: string | null;
		captionSidecar?: {
			format: "srt" | "vtt" | "both";
			cues: Array<{
				startMs: number;
				endMs: number;
				text: string;
			}>;
		};
	}) => {
		return ipcRenderer.invoke("finalize-exported-video", payload);
	},
	discardExportedTemp: (tempPath: string) => {
		return ipcRenderer.invoke("discard-exported-temp", tempPath);
	},
	getVideoAudioFallbackPaths: (videoPath: string) => {
		return ipcRenderer.invoke("get-video-audio-fallback-paths", videoPath);
	},
	getSources: async (opts: Electron.SourcesOptions) => {
		return await ipcRenderer.invoke("get-sources", opts);
	},
	switchToEditor: () => {
		return ipcRenderer.invoke("switch-to-editor");
	},
	openSourceSelector: () => {
		return ipcRenderer.invoke("open-source-selector");
	},
	selectSource: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("select-source", source);
	},
	showSourceHighlight: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("show-source-highlight", source);
	},
	getSelectedSource: () => {
		return ipcRenderer.invoke("get-selected-source");
	},
	onSelectedSourceChanged: (callback: (source: ProcessedDesktopSource | null) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: ProcessedDesktopSource | null,
		) => callback(payload);
		ipcRenderer.on("selected-source-changed", listener);
		return () => ipcRenderer.removeListener("selected-source-changed", listener);
	},
	startNativeScreenRecording: (
		source: ProcessedDesktopSource,
		options?: {
			capturesSystemAudio?: boolean;
			capturesMicrophone?: boolean;
			microphoneDeviceId?: string;
			microphoneLabel?: string;
		},
	) => {
		return ipcRenderer.invoke("start-native-screen-recording", source, options);
	},
	stopNativeScreenRecording: () => {
		return ipcRenderer.invoke("stop-native-screen-recording");
	},
	recoverNativeScreenRecording: () => {
		return ipcRenderer.invoke("recover-native-screen-recording");
	},
	getLastNativeCaptureDiagnostics: () => {
		return ipcRenderer.invoke("get-last-native-capture-diagnostics");
	},
	pauseNativeScreenRecording: () => {
		return ipcRenderer.invoke("pause-native-screen-recording");
	},
	resumeNativeScreenRecording: () => {
		return ipcRenderer.invoke("resume-native-screen-recording");
	},
	pauseCursorCapture: (pausedAtMs?: number) => {
		return ipcRenderer.invoke("pause-cursor-capture", pausedAtMs);
	},
	resumeCursorCapture: (resumedAtMs?: number) => {
		return ipcRenderer.invoke("resume-cursor-capture", resumedAtMs);
	},
	startFfmpegRecording: (source: ProcessedDesktopSource) => {
		return ipcRenderer.invoke("start-ffmpeg-recording", source);
	},
	stopFfmpegRecording: () => {
		return ipcRenderer.invoke("stop-ffmpeg-recording");
	},
	storeRecordedVideo: (videoData: ArrayBuffer, fileName: string) => {
		return ipcRenderer.invoke("store-recorded-video", videoData, fileName);
	},
	storeMicrophoneSidecar: (
		audioData: ArrayBuffer,
		videoPath: string,
		options?: {
			startDelayMs?: number;
			browserMicrophoneProfile?: string;
			requestedBrowserMicrophoneProfile?: string | null;
			requestedConstraints?: unknown;
			mediaTrackSettings?: Record<string, boolean | number | string>;
			audioInputDevices?: Array<{
				deviceId: string;
				groupId?: string;
				label: string;
			}>;
			mediaRecorder?: {
				mimeType?: string;
				audioBitsPerSecond?: number;
				timesliceMs?: number;
			};
			chunkEvents?: Array<{
				index: number;
				size: number;
				elapsedMs: number;
				deltaMs: number | null;
			}>;
		},
	) => {
		return ipcRenderer.invoke("store-microphone-sidecar", audioData, videoPath, options);
	},
	getRecordedVideoPath: () => {
		return ipcRenderer.invoke("get-recorded-video-path");
	},
	setRecordingState: (recording: boolean) => {
		return ipcRenderer.invoke("set-recording-state", recording);
	},
	setCursorScale: (scale: number) => {
		return ipcRenderer.invoke("set-cursor-scale", scale);
	},
	getCursorTelemetry: (videoPath?: string) => {
		return ipcRenderer.invoke("get-cursor-telemetry", videoPath);
	},
	setCursorTelemetry: (videoPath: string | undefined, samples: CursorTelemetryPoint[]) => {
		return ipcRenderer.invoke("set-cursor-telemetry", videoPath, samples);
	},
	getSystemCursorAssets: () => {
		return ipcRenderer.invoke("get-system-cursor-assets");
	},
	onStopRecordingFromTray: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("stop-recording-from-tray", listener);
		return () => ipcRenderer.removeListener("stop-recording-from-tray", listener);
	},
	onRecordingStateChanged: (
		callback: (state: { recording: boolean; sourceName: string }) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { recording: boolean; sourceName: string },
		) => callback(payload);
		ipcRenderer.on("recording-state-changed", listener);
		return () => ipcRenderer.removeListener("recording-state-changed", listener);
	},
	onRecordingInterrupted: (callback: (state: { reason: string; message: string }) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { reason: string; message: string },
		) => callback(payload);
		ipcRenderer.on("recording-interrupted", listener);
		return () => ipcRenderer.removeListener("recording-interrupted", listener);
	},
	onCursorStateChanged: (
		callback: (state: { cursorType: CursorTelemetryPoint["cursorType"] }) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { cursorType: CursorTelemetryPoint["cursorType"] },
		) => callback(payload);
		ipcRenderer.on("cursor-state-changed", listener);
		return () => ipcRenderer.removeListener("cursor-state-changed", listener);
	},
	openExternalUrl: (url: string) => {
		return ipcRenderer.invoke("open-external-url", url);
	},
	getAccessibilityPermissionStatus: () => {
		return ipcRenderer.invoke("get-accessibility-permission-status");
	},
	requestAccessibilityPermission: () => {
		return ipcRenderer.invoke("request-accessibility-permission");
	},
	getScreenRecordingPermissionStatus: () => {
		return ipcRenderer.invoke("get-screen-recording-permission-status");
	},
	openScreenRecordingPreferences: () => {
		return ipcRenderer.invoke("open-screen-recording-preferences");
	},
	openAccessibilityPreferences: () => {
		return ipcRenderer.invoke("open-accessibility-preferences");
	},
	saveExportedVideo: (
		videoData: ArrayBuffer,
		fileName: string,
		captionSidecar?: {
			format: "srt" | "vtt" | "both";
			cues: Array<{
				startMs: number;
				endMs: number;
				text: string;
			}>;
		},
	) => {
		return ipcRenderer.invoke("save-exported-video", videoData, fileName, captionSidecar);
	},
	writeExportedVideoToPath: (
		videoData: ArrayBuffer,
		outputPath: string,
		captionSidecar?: {
			format: "srt" | "vtt" | "both";
			cues: Array<{
				startMs: number;
				endMs: number;
				text: string;
			}>;
		},
	) => {
		return ipcRenderer.invoke(
			"write-exported-video-to-path",
			videoData,
			outputPath,
			captionSidecar,
		);
	},
	openVideoFilePicker: (options?: { includeProjects?: boolean }) => {
		return ipcRenderer.invoke("open-video-file-picker", options);
	},
	openAudioFilePicker: () => {
		return ipcRenderer.invoke("open-audio-file-picker");
	},
	openWhisperExecutablePicker: () => {
		return ipcRenderer.invoke("open-whisper-executable-picker");
	},
	openWhisperModelPicker: () => {
		return ipcRenderer.invoke("open-whisper-model-picker");
	},
	getWhisperSmallModelStatus: () => {
		return ipcRenderer.invoke("get-whisper-small-model-status");
	},
	downloadWhisperSmallModel: () => {
		return ipcRenderer.invoke("download-whisper-small-model");
	},
	deleteWhisperSmallModel: () => {
		return ipcRenderer.invoke("delete-whisper-small-model");
	},
	onWhisperSmallModelDownloadProgress: (
		callback: (state: {
			status: "idle" | "downloading" | "downloaded" | "error";
			progress: number;
			path?: string | null;
			error?: string;
		}) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: {
				status: "idle" | "downloading" | "downloaded" | "error";
				progress: number;
				path?: string | null;
				error?: string;
			},
		) => callback(payload);
		ipcRenderer.on("whisper-small-model-download-progress", listener);
		return () => ipcRenderer.removeListener("whisper-small-model-download-progress", listener);
	},
	generateAutoCaptions: (options: {
		videoPath: string;
		whisperExecutablePath?: string;
		whisperModelPath: string;
		language?: string;
	}) => {
		return ipcRenderer.invoke("generate-auto-captions", options);
	},
	setCurrentVideoPath: (
		path: string,
		options?: {
			preserveProjectPath?: boolean;
			hideOverlayCursorByDefault?: boolean;
		},
	) => {
		return ipcRenderer.invoke("set-current-video-path", path, options);
	},
	setCurrentRecordingSession: (
		session: {
			videoPath: string;
			webcamPath?: string | null;
			timeOffsetMs?: number;
			hideOverlayCursorByDefault?: boolean;
		},
		options?: { preserveProjectPath?: boolean },
	) => {
		return ipcRenderer.invoke("set-current-recording-session", session, options);
	},
	onRecordingSessionChanged: (callback: (session: RecordingSessionData | null) => void) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: RecordingSessionData | null,
		) => callback(payload);
		ipcRenderer.on("recording-session-changed", listener);
		return () => ipcRenderer.removeListener("recording-session-changed", listener);
	},
	getCurrentRecordingSession: () => {
		return ipcRenderer.invoke("get-current-recording-session");
	},
	getCurrentVideoPath: () => {
		return ipcRenderer.invoke("get-current-video-path");
	},
	clearCurrentVideoPath: () => {
		return ipcRenderer.invoke("clear-current-video-path");
	},
	deleteRecordingFile: (filePath: string) => {
		return ipcRenderer.invoke("delete-recording-file", filePath);
	},
	getLocalMediaUrl: (filePath: string) => {
		return ipcRenderer.invoke("get-local-media-url", filePath) as Promise<
			{ success: true; url: string } | { success: false }
		>;
	},
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
		thumbnailDataUrl?: string | null,
	) => {
		return ipcRenderer.invoke(
			"save-project-file",
			projectData,
			suggestedName,
			existingProjectPath,
			thumbnailDataUrl,
		);
	},
	saveProjectFileNamed: (
		projectData: unknown,
		projectName: string,
		thumbnailDataUrl?: string | null,
		mode?: "rename" | "copy",
	) => {
		return ipcRenderer.invoke(
			"save-project-file-named",
			projectData,
			projectName,
			thumbnailDataUrl,
			mode,
		);
	},
	loadProjectFile: () => {
		return ipcRenderer.invoke("load-project-file");
	},
	loadCurrentProjectFile: () => {
		return ipcRenderer.invoke("load-current-project-file");
	},
	getProjectsDirectory: () => {
		return ipcRenderer.invoke("get-projects-directory");
	},
	listProjectFiles: () => {
		return ipcRenderer.invoke("list-project-files");
	},
	openProjectFileAtPath: (filePath: string) => {
		return ipcRenderer.invoke("open-project-file-at-path", filePath);
	},
	openProjectsDirectory: () => {
		return ipcRenderer.invoke("open-projects-directory");
	},
	installDownloadedUpdate: () => {
		return ipcRenderer.invoke("install-downloaded-update");
	},
	downloadAvailableUpdate: (installAfterDownload?: boolean) => {
		return ipcRenderer.invoke("download-available-update", installAfterDownload);
	},
	deferDownloadedUpdate: (delayMs?: number) => {
		return ipcRenderer.invoke("defer-downloaded-update", delayMs);
	},
	dismissUpdateToast: () => {
		return ipcRenderer.invoke("dismiss-update-toast");
	},
	skipUpdateVersion: () => {
		return ipcRenderer.invoke("skip-update-version");
	},
	getCurrentUpdateToastPayload: () => {
		return ipcRenderer.invoke("get-current-update-toast-payload");
	},
	getUpdateStatusSummary: () => {
		return ipcRenderer.invoke("get-update-status-summary");
	},
	getExperimentalUpdatesEnabled: () => {
		return ipcRenderer.invoke("get-experimental-updates-enabled");
	},
	setExperimentalUpdatesEnabled: (enabled: boolean) => {
		return ipcRenderer.invoke("set-experimental-updates-enabled", enabled);
	},
	previewUpdateToast: () => {
		return ipcRenderer.invoke("preview-update-toast");
	},
	checkForAppUpdates: () => {
		return ipcRenderer.invoke("check-for-app-updates");
	},
	onUpdateToastStateChanged: (
		callback: (
			payload: {
				version: string;
				detail: string;
				phase: "available" | "downloading" | "ready" | "error";
				delayMs: number;
				isPreview?: boolean;
				progressPercent?: number;
				transferredBytes?: number;
				totalBytes?: number;
				remainingBytes?: number;
				bytesPerSecond?: number;
				primaryAction?: "install-and-restart" | "retry-check";
			} | null,
		) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: {
				version: string;
				detail: string;
				phase: "available" | "downloading" | "ready" | "error";
				delayMs: number;
				isPreview?: boolean;
				progressPercent?: number;
				transferredBytes?: number;
				totalBytes?: number;
				remainingBytes?: number;
				bytesPerSecond?: number;
				primaryAction?: "install-and-restart" | "retry-check";
			} | null,
		) => callback(payload);
		ipcRenderer.on("update-toast-state", listener);
		return () => ipcRenderer.removeListener("update-toast-state", listener);
	},
	onUpdateReadyToast: (
		callback: (payload: {
			version: string;
			detail: string;
			delayMs: number;
			isPreview?: boolean;
		}) => void,
	) => {
		const listener = (
			_event: Electron.IpcRendererEvent,
			payload: { version: string; detail: string; delayMs: number; isPreview?: boolean },
		) => callback(payload);
		ipcRenderer.on("update-ready-toast", listener);
		return () => ipcRenderer.removeListener("update-ready-toast", listener);
	},
	onMenuLoadProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-load-project", listener);
		return () => ipcRenderer.removeListener("menu-load-project", listener);
	},
	onMenuSaveProject: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project", listener);
		return () => ipcRenderer.removeListener("menu-save-project", listener);
	},
	onMenuSaveProjectAs: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu-save-project-as", listener);
		return () => ipcRenderer.removeListener("menu-save-project-as", listener);
	},
	getPlatform: () => {
		return ipcRenderer.invoke("get-platform");
	},
	getLinuxWindowSystem: () => {
		return ipcRenderer.invoke("get-linux-window-system");
	},
	revealInFolder: (filePath: string) => {
		return ipcRenderer.invoke("reveal-in-folder", filePath);
	},
	openRecordingsFolder: () => {
		return ipcRenderer.invoke("open-recordings-folder");
	},
	getRecordingsDirectory: () => {
		return ipcRenderer.invoke("get-recordings-directory");
	},
	chooseRecordingsDirectory: () => {
		return ipcRenderer.invoke("choose-recordings-directory");
	},
	getShortcuts: () => {
		return ipcRenderer.invoke("get-shortcuts");
	},
	saveShortcuts: (shortcuts: unknown) => {
		return ipcRenderer.invoke("save-shortcuts", shortcuts);
	},
	getAppSetting: (key: string) => {
		const result = ipcRenderer.sendSync("app-settings:get", key) as {
			success?: boolean;
			value?: unknown;
		};
		return result?.success ? (result.value ?? null) : null;
	},
	setAppSetting: (key: string, value: unknown) => {
		const result = ipcRenderer.sendSync("app-settings:set", key, value) as {
			success?: boolean;
		};
		return result?.success === true;
	},
	setHasUnsavedChanges: (hasChanges: boolean) => {
		ipcRenderer.send("set-has-unsaved-changes", hasChanges);
	},
	onRequestSaveBeforeClose: (callback: () => Promise<boolean>) => {
		const listener = async () => {
			let saved = false;
			try {
				saved = await callback();
			} catch {
				saved = false;
			}
			ipcRenderer.send("save-before-close-done", saved);
		};
		ipcRenderer.on("request-save-before-close", listener);
		return () => ipcRenderer.removeListener("request-save-before-close", listener);
	},
	isNativeWindowsCaptureAvailable: () =>
		ipcRenderer.invoke("is-native-windows-capture-available"),
	muxNativeWindowsRecording: (expectedDurationMs?: number) =>
		ipcRenderer.invoke("mux-native-windows-recording", expectedDurationMs),
	hideOsCursor: () => ipcRenderer.invoke("hide-cursor"),
	getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
	getAnnouncements: () => ipcRenderer.invoke("announcements:get"),
	getRecordingPreferences: () => ipcRenderer.invoke("get-recording-preferences"),
	getRecordingAudioLabConfig: () => ipcRenderer.invoke("get-recording-audio-lab-config"),
	setRecordingPreferences: (prefs: {
		microphoneEnabled?: boolean;
		microphoneDeviceId?: string;
		systemAudioEnabled?: boolean;
		webcamEnabled?: boolean;
		webcamDeviceId?: string;
	}) => ipcRenderer.invoke("set-recording-preferences", prefs),
	getCountdownDelay: () => ipcRenderer.invoke("get-countdown-delay"),
	setCountdownDelay: (delay: number) => ipcRenderer.invoke("set-countdown-delay", delay),
	startCountdown: (seconds: number) => ipcRenderer.invoke("start-countdown", seconds),
	cancelCountdown: () => ipcRenderer.invoke("cancel-countdown"),
	getActiveCountdown: () => ipcRenderer.invoke("get-active-countdown"),
	onCountdownTick: (callback: (seconds: number) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, seconds: number) => callback(seconds);
		ipcRenderer.on("countdown-tick", listener);
		return () => ipcRenderer.removeListener("countdown-tick", listener);
	},
	/**
	 * Registers a handler for commands sent by the local control server
	 * (see electron/control/server.ts). Returns an unsubscribe function.
	 * A handler must return a JSON-serializable value or throw.
	 */
	onControlCommand: (
		handler: (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown,
	) => {
		controlCommandHandlers.add(handler);
		return () => {
			controlCommandHandlers.delete(handler);
		};
	},
});

// ── Control server bridge ─────────────────────────────────────────────────────
// The control server (opt-in, loopback only) drives the app for automation and
// the Recordly MCP server. Generic "ui.*" commands are answered here because
// the preload script can see the DOM; everything else is forwarded to
// handlers registered by the renderer via onControlCommand.

type ControlCommandHandler = (
	name: string,
	args: Record<string, unknown>,
) => Promise<unknown> | unknown;

const controlCommandHandlers = new Set<ControlCommandHandler>();
const CONTROL_UNHANDLED = Symbol("control-unhandled");
const uiRefs = new Map<string, Element>();

const UI_SNAPSHOT_SELECTOR = [
	"button",
	"a[href]",
	"input",
	"select",
	"textarea",
	"[role='button']",
	"[role='menuitem']",
	"[role='menuitemradio']",
	"[role='menuitemcheckbox']",
	"[role='option']",
	"[role='tab']",
	"[role='switch']",
	"[role='checkbox']",
	"[role='radio']",
	"[role='slider']",
	"[role='combobox']",
	"[role='dialog']",
	"[contenteditable='true']",
	"[data-testid]",
].join(",");

function isElementVisible(element: Element): boolean {
	if (!(element instanceof HTMLElement)) {
		return true;
	}
	const style = window.getComputedStyle(element);
	if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
		return false;
	}
	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

function describeElementName(element: Element): string {
	const aria = element.getAttribute("aria-label");
	if (aria?.trim()) return aria.trim();
	const labelledBy = element.getAttribute("aria-labelledby");
	if (labelledBy) {
		const text = labelledBy
			.split(/\s+/)
			.map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
			.filter(Boolean)
			.join(" ");
		if (text) return text;
	}
	const title = element.getAttribute("title");
	if (title?.trim()) return title.trim();
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
		if (element.placeholder?.trim()) return element.placeholder.trim();
		if (element.id) {
			const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
			if (label?.textContent?.trim()) return label.textContent.trim();
		}
	}
	const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
	return text.slice(0, 120);
}

function describeElementRole(element: Element): string {
	const role = element.getAttribute("role");
	if (role) return role;
	const tag = element.tagName.toLowerCase();
	if (tag === "input") {
		return `input:${(element as HTMLInputElement).type || "text"}`;
	}
	if (tag === "a") return "link";
	return tag;
}

function elementBounds(element: Element) {
	const rect = element.getBoundingClientRect();
	return {
		x: Math.round(rect.left),
		y: Math.round(rect.top),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	};
}

function snapshotUi(args: Record<string, unknown>) {
	uiRefs.clear();
	const includeHidden = args.includeHidden === true;
	const limit =
		typeof args.limit === "number" && Number.isFinite(args.limit)
			? Math.max(1, Math.min(500, Math.floor(args.limit)))
			: 200;
	const elements = Array.from(document.querySelectorAll(UI_SNAPSHOT_SELECTOR));
	const items: Array<Record<string, unknown>> = [];
	for (const element of elements) {
		if (!includeHidden && !isElementVisible(element)) {
			continue;
		}
		const ref = `ref_${items.length + 1}`;
		uiRefs.set(ref, element);
		const item: Record<string, unknown> = {
			ref,
			role: describeElementRole(element),
			name: describeElementName(element),
			bounds: elementBounds(element),
		};
		if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
			if (element.disabled) item.disabled = true;
		}
		if (element instanceof HTMLInputElement) {
			if (element.type === "checkbox" || element.type === "radio") {
				item.checked = element.checked;
			} else if (element.type !== "password") {
				item.value = element.value;
			}
		} else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
			item.value = element.value;
		}
		const ariaChecked = element.getAttribute("aria-checked");
		if (ariaChecked !== null) item.checked = ariaChecked === "true";
		const ariaExpanded = element.getAttribute("aria-expanded");
		if (ariaExpanded !== null) item.expanded = ariaExpanded === "true";
		const ariaSelected = element.getAttribute("aria-selected");
		if (ariaSelected !== null) item.selected = ariaSelected === "true";
		const dataState = element.getAttribute("data-state");
		if (dataState) item.state = dataState;
		const testId = element.getAttribute("data-testid");
		if (testId) item.testId = testId;
		items.push(item);
		if (items.length >= limit) break;
	}
	const bodyText = (document.body?.innerText ?? "").replace(/\s+\n/g, "\n").trim();
	return {
		url: window.location.href,
		title: document.title,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		elements: items,
		text: bodyText.slice(0, 4000),
	};
}

function resolveUiElement(args: Record<string, unknown>): Element {
	const ref = typeof args.ref === "string" ? args.ref : null;
	if (ref) {
		const element = uiRefs.get(ref);
		if (!element || !element.isConnected) {
			throw new Error(`Unknown or stale ref "${ref}". Take a new ui.snapshot first.`);
		}
		return element;
	}
	const selector = typeof args.selector === "string" ? args.selector : null;
	if (selector) {
		const element = document.querySelector(selector);
		if (!element) {
			throw new Error(`No element matches selector "${selector}".`);
		}
		return element;
	}
	const text = typeof args.text === "string" ? args.text.trim().toLowerCase() : "";
	if (text) {
		const candidates = Array.from(document.querySelectorAll(UI_SNAPSHOT_SELECTOR)).filter(
			(element) => isElementVisible(element),
		);
		const exact = candidates.find(
			(element) => describeElementName(element).toLowerCase() === text,
		);
		const partial = candidates.find((element) =>
			describeElementName(element).toLowerCase().includes(text),
		);
		const element = exact ?? partial;
		if (!element) {
			throw new Error(`No visible element with text "${args.text}".`);
		}
		return element;
	}
	throw new Error('Provide "ref", "selector" or "text".');
}

function setUiValue(args: Record<string, unknown>) {
	const element = resolveUiElement(args);
	const value = args.value;
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
		if (
			element instanceof HTMLInputElement &&
			(element.type === "checkbox" || element.type === "radio")
		) {
			const next = Boolean(value);
			if (element.checked !== next) {
				element.click();
			}
			return { checked: element.checked };
		}
		const prototype =
			element instanceof HTMLInputElement
				? HTMLInputElement.prototype
				: HTMLTextAreaElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
		element.focus();
		if (setter) {
			setter.call(element, String(value ?? ""));
		} else {
			element.value = String(value ?? "");
		}
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		return { value: element.value };
	}
	if (element instanceof HTMLSelectElement) {
		element.value = String(value ?? "");
		element.dispatchEvent(new Event("change", { bubbles: true }));
		return { value: element.value };
	}
	if (element instanceof HTMLElement && element.isContentEditable) {
		element.focus();
		element.textContent = String(value ?? "");
		element.dispatchEvent(new InputEvent("input", { bubbles: true }));
		return { value: element.textContent };
	}
	throw new Error("Element does not accept a value.");
}

async function handlePreloadUiCommand(
	name: string,
	args: Record<string, unknown>,
): Promise<unknown | typeof CONTROL_UNHANDLED> {
	switch (name) {
		case "ui.snapshot":
			return snapshotUi(args);
		case "ui.locate": {
			const element = resolveUiElement(args);
			if (element instanceof HTMLElement) {
				element.scrollIntoView({ block: "nearest", inline: "nearest" });
			}
			return elementBounds(element);
		}
		case "ui.setValue":
			return setUiValue(args);
		case "ui.focus": {
			const element = resolveUiElement(args);
			if (element instanceof HTMLElement) {
				element.focus();
			}
			return { ok: true };
		}
		case "ui.text":
			return { text: (document.body?.innerText ?? "").trim().slice(0, 20000) };
		default:
			return CONTROL_UNHANDLED;
	}
}

ipcRenderer.on(
	"control-command",
	async (_event, payload: { id: string; name: string; args?: Record<string, unknown> }) => {
		const { id, name } = payload;
		const args = payload.args ?? {};
		try {
			const preloadResult = await handlePreloadUiCommand(name, args);
			if (preloadResult !== CONTROL_UNHANDLED) {
				ipcRenderer.send("control-command-result", { id, ok: true, result: preloadResult });
				return;
			}
			for (const handler of controlCommandHandlers) {
				const result = await handler(name, args);
				if (result !== CONTROL_COMMAND_UNHANDLED_RESULT) {
					ipcRenderer.send("control-command-result", {
						id,
						ok: true,
						result: result ?? null,
					});
					return;
				}
			}
			ipcRenderer.send("control-command-result", {
				id,
				ok: false,
				error: `No handler in this window for control command "${name}".`,
			});
		} catch (error) {
			ipcRenderer.send("control-command-result", {
				id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},
);

/** Sentinel a renderer handler returns to say "not mine, try the next handler". */
const CONTROL_COMMAND_UNHANDLED_RESULT = "__recordly_control_unhandled__";
