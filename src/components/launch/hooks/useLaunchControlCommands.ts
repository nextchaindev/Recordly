import { useEffect, useRef } from "react";
import { registerControlCommands } from "@/lib/controlCommands";
import { type DesktopSource, mapRawSource } from "../popovers/launchPopoverTypes";

type RecorderControls = {
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	toggleRecording: () => void | Promise<void>;
	pauseRecording: () => void;
	resumeRecording: () => void;
	cancelRecording: () => void;
	microphoneEnabled: boolean;
	setMicrophoneEnabled: (enabled: boolean) => void;
	systemAudioEnabled: boolean;
	setSystemAudioEnabled: (enabled: boolean) => void;
	webcamEnabled: boolean;
	setWebcamEnabled: (enabled: boolean) => void;
	countdownDelay: number;
	setCountdownDelay: (delay: number) => void;
	handleSourceSelect: (source: DesktopSource) => Promise<void>;
};

function snapshot(controls: RecorderControls) {
	return {
		recording: controls.recording,
		paused: controls.paused,
		finalizing: controls.finalizing,
		countdownActive: controls.countdownActive,
		microphoneEnabled: controls.microphoneEnabled,
		systemAudioEnabled: controls.systemAudioEnabled,
		webcamEnabled: controls.webcamEnabled,
		countdownDelay: controls.countdownDelay,
	};
}

/**
 * Exposes the HUD's recording controls to the local control server so the
 * Recordly MCP server (or any automation) can drive recordings without
 * clicking the HUD.
 */
export function useLaunchControlCommands(controls: RecorderControls) {
	const latest = useRef(controls);
	latest.current = controls;

	useEffect(() => {
		return registerControlCommands({
			"recording.state": () => snapshot(latest.current),
			"recording.start": async (args) => {
				const current = latest.current;
				if (current.recording) {
					return { ...snapshot(current), alreadyRecording: true };
				}
				if (current.finalizing) {
					throw new Error("Previous recording is still finalizing.");
				}
				if (current.countdownActive) {
					return { ...snapshot(current), countdownAlreadyActive: true };
				}
				if (typeof args.countdownSeconds === "number") {
					current.setCountdownDelay(Math.max(0, Math.floor(args.countdownSeconds)));
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				await latest.current.toggleRecording();
				return { ...snapshot(latest.current), started: true };
			},
			"recording.stop": async () => {
				const current = latest.current;
				if (!current.recording) {
					throw new Error("No recording is in progress.");
				}
				await current.toggleRecording();
				return { ...snapshot(latest.current), stopped: true };
			},
			"recording.pause": () => {
				const current = latest.current;
				if (!current.recording) {
					throw new Error("No recording is in progress.");
				}
				if (!current.paused) {
					current.pauseRecording();
				}
				return { ...snapshot(latest.current), paused: true };
			},
			"recording.resume": () => {
				const current = latest.current;
				if (!current.recording) {
					throw new Error("No recording is in progress.");
				}
				if (current.paused) {
					current.resumeRecording();
				}
				return { ...snapshot(latest.current), paused: false };
			},
			"recording.cancel": () => {
				const current = latest.current;
				if (!current.recording) {
					return { ...snapshot(current), cancelled: false };
				}
				current.cancelRecording();
				return { ...snapshot(latest.current), cancelled: true };
			},
			"recording.preferences": (args) => {
				const current = latest.current;
				if (typeof args.microphoneEnabled === "boolean") {
					current.setMicrophoneEnabled(args.microphoneEnabled);
				}
				if (typeof args.systemAudioEnabled === "boolean") {
					current.setSystemAudioEnabled(args.systemAudioEnabled);
				}
				if (typeof args.webcamEnabled === "boolean") {
					current.setWebcamEnabled(args.webcamEnabled);
				}
				if (typeof args.countdownSeconds === "number") {
					current.setCountdownDelay(Math.max(0, Math.floor(args.countdownSeconds)));
				}
				return snapshot(latest.current);
			},
			"sources.list": async (args) => {
				const types = Array.isArray(args.types)
					? (args.types.filter(
							(type): type is "screen" | "window" =>
								type === "screen" || type === "window",
						) as Array<"screen" | "window">)
					: (["screen", "window"] as Array<"screen" | "window">);
				const raw = await window.electronAPI.getSources({
					types,
					thumbnailSize: { width: 1, height: 1 },
					fetchWindowIcons: false,
				});
				return raw.map((source) => {
					const mapped = mapRawSource(source as DesktopSource);
					return {
						id: mapped.id,
						name: mapped.name,
						sourceType: mapped.sourceType,
						appName: mapped.appName,
						windowTitle: mapped.windowTitle,
						display_id: mapped.display_id,
					};
				});
			},
			"sources.select": async (args) => {
				const id = typeof args.id === "string" ? args.id : "";
				if (!id) {
					throw new Error('"id" is required.');
				}
				const raw = await window.electronAPI.getSources({
					types: ["screen", "window"],
					thumbnailSize: { width: 1, height: 1 },
					fetchWindowIcons: false,
				});
				const match = raw
					.map((source) => mapRawSource(source as DesktopSource))
					.find((source) => source.id === id);
				if (!match) {
					throw new Error(`Capture source "${id}" is no longer available.`);
				}
				await latest.current.handleSourceSelect(match);
				return { id: match.id, name: match.name, sourceType: match.sourceType };
			},
			"project.open": async (args) => {
				const projectPath = typeof args.projectPath === "string" ? args.projectPath : "";
				const videoPath = typeof args.videoPath === "string" ? args.videoPath : "";
				if (projectPath) {
					const result = await window.electronAPI.openProjectFileAtPath(projectPath);
					if (result.canceled || !result.success) {
						throw new Error(
							"error" in result && typeof result.error === "string"
								? result.error
								: `Could not open project "${projectPath}".`,
						);
					}
					await window.electronAPI.switchToEditor();
					return { opened: "project", path: projectPath };
				}
				if (videoPath) {
					await window.electronAPI.setCurrentVideoPath(videoPath);
					await window.electronAPI.switchToEditor();
					return { opened: "video", path: videoPath };
				}
				await window.electronAPI.switchToEditor();
				return { opened: "editor" };
			},
		});
	}, []);
}
