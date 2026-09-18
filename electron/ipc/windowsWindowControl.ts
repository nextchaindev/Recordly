import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SelectedSource, WindowBounds } from "./types";
import { getScreen, parseWindowId } from "./utils";
import { convertPhysicalBoundsToDip } from "./windowsCaptureSelection";

const execFileAsync = promisify(execFile);

export async function bringWindowsWindowForward(windowId: number): Promise<void> {
	const script = [
		'Add-Type -TypeDefinition @"',
		"using System; using System.Runtime.InteropServices;",
		"public static class RecordlyForegroundWindow {",
		'  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
		'  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
		'  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
		"}",
		'"@',
		"$handle = [IntPtr][Int64]$env:RECORDLY_WINDOW_ID",
		"if ([RecordlyForegroundWindow]::IsIconic($handle)) { [RecordlyForegroundWindow]::ShowWindowAsync($handle, 9) | Out-Null }",
		"[RecordlyForegroundWindow]::SetForegroundWindow($handle) | Out-Null",
	].join("\n");

	await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
		timeout: 5000,
		env: { ...process.env, RECORDLY_WINDOW_ID: String(windowId) },
	});
}

export type WindowsWindowStyleInfo = {
	windowId: number;
	hasCaption: boolean;
	toolWindow: boolean;
	transparent: boolean;
	layered: boolean;
	visible: boolean;
	width: number;
	height: number;
};

/**
 * Reads window styles and outer size for several HWNDs in one PowerShell
 * call. Used to tell a real application window apart from overlay/mascot
 * windows that reuse the app's title (those are typically layered,
 * transparent tool windows without a caption).
 */
export async function probeWindowsWindowStyles(
	windowIds: number[],
): Promise<WindowsWindowStyleInfo[]> {
	if (windowIds.length === 0) return [];
	const script = [
		'Add-Type -TypeDefinition @"',
		"using System; using System.Runtime.InteropServices;",
		"public static class RecordlyWindowProbe {",
		"  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
		'  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);',
		'  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
		'  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
		"}",
		'"@',
		"$ids = $env:RECORDLY_WINDOW_IDS -split ','",
		"$out = @()",
		"foreach ($id in $ids) {",
		"  if (-not $id) { continue }",
		"  $h = [IntPtr][Int64]$id",
		"  $style = [Int64][RecordlyWindowProbe]::GetWindowLongPtr($h, -16)",
		"  $ex = [Int64][RecordlyWindowProbe]::GetWindowLongPtr($h, -20)",
		"  $r = New-Object RecordlyWindowProbe+RECT",
		"  [RecordlyWindowProbe]::GetWindowRect($h, [ref]$r) | Out-Null",
		"  $out += [pscustomobject]@{ id = [Int64]$id; style = $style; ex = $ex; visible = [RecordlyWindowProbe]::IsWindowVisible($h); w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }",
		"}",
		"$out | ConvertTo-Json -Compress",
	].join("\n");

	const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
		timeout: 8000,
		env: { ...process.env, RECORDLY_WINDOW_IDS: windowIds.join(",") },
	});
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed) as unknown;
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const WS_CAPTION = 0x00c00000;
	const WS_EX_TOOLWINDOW = 0x00000080;
	const WS_EX_TRANSPARENT = 0x00000020;
	const WS_EX_LAYERED = 0x00080000;
	return rows.map((row) => {
		const record = row as Record<string, unknown>;
		const style = Number(record.style ?? 0);
		const ex = Number(record.ex ?? 0);
		return {
			windowId: Number(record.id),
			hasCaption: (style & WS_CAPTION) === WS_CAPTION,
			toolWindow: (ex & WS_EX_TOOLWINDOW) !== 0,
			transparent: (ex & WS_EX_TRANSPARENT) !== 0,
			layered: (ex & WS_EX_LAYERED) !== 0,
			visible: Boolean(record.visible),
			width: Number(record.w ?? 0),
			height: Number(record.h ?? 0),
		};
	});
}

/**
 * Moves/resizes a top-level window (restoring it first if minimized or
 * maximized). Bounds are in physical pixels. Used by the control server so
 * automation can frame a target app at an exact size away from screen-edge
 * overlays before recording it.
 */
export async function arrangeWindowsWindow(
	windowId: number,
	bounds: { x: number; y: number; width: number; height: number },
): Promise<void> {
	const script = [
		'Add-Type -TypeDefinition @"',
		"using System; using System.Runtime.InteropServices;",
		"public static class RecordlyArrangeWindow {",
		'  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
		'  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
		'  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
		'  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);',
		"}",
		'"@',
		"[RecordlyArrangeWindow]::SetThreadDpiAwarenessContext([IntPtr]::op_Explicit(-4)) | Out-Null",
		"$handle = [IntPtr][Int64]$env:RECORDLY_WINDOW_ID",
		"[RecordlyArrangeWindow]::ShowWindowAsync($handle, 9) | Out-Null",
		"Start-Sleep -Milliseconds 120",
		"[RecordlyArrangeWindow]::SetWindowPos($handle, [IntPtr]::Zero, [int]$env:RECORDLY_X, [int]$env:RECORDLY_Y, [int]$env:RECORDLY_W, [int]$env:RECORDLY_H, 0x0044) | Out-Null",
		"[RecordlyArrangeWindow]::SetForegroundWindow($handle) | Out-Null",
	].join("\n");

	await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
		timeout: 8000,
		env: {
			...process.env,
			RECORDLY_WINDOW_ID: String(windowId),
			RECORDLY_X: String(Math.round(bounds.x)),
			RECORDLY_Y: String(Math.round(bounds.y)),
			RECORDLY_W: String(Math.round(bounds.width)),
			RECORDLY_H: String(Math.round(bounds.height)),
		},
	});
}

export async function resolveWindowsWindowBounds(
	source: SelectedSource,
): Promise<WindowBounds | null> {
	const windowId = parseWindowId(source.id);
	const windowTitle =
		typeof source.windowTitle === "string" ? source.windowTitle.trim() : source.name.trim();

	if (!windowId && !windowTitle) return null;

	const script = [
		"$windowId = $env:RECORDLY_WINDOW_ID",
		"$windowTitle = $env:RECORDLY_WINDOW_TITLE",
		'Add-Type -TypeDefinition @"',
		"using System;",
		"using System.Runtime.InteropServices;",
		"public static class RecordlyWindowBounds {",
		"  [StructLayout(LayoutKind.Sequential)]",
		"  public struct RECT {",
		"    public int Left;",
		"    public int Top;",
		"    public int Right;",
		"    public int Bottom;",
		"  }",
		'  [DllImport("user32.dll")]',
		"  [return: MarshalAs(UnmanagedType.Bool)]",
		"  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);",
		'  [DllImport("dwmapi.dll")]',
		"  public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);",
		'  [DllImport("user32.dll")]',
		"  public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);",
		"}",
		'"@',
		"$handle = [Int64]0",
		"if ($windowId) { $handle = [Int64]$windowId }",
		"$escapedWindowTitle = if ($windowTitle) { [WildcardPattern]::Escape($windowTitle) } else { $null }",
		"if ($handle -le 0 -and $windowTitle) {",
		'  $matchingProcess = Get-Process | Where-Object { $_.MainWindowTitle -eq $windowTitle -or ($escapedWindowTitle -and $_.MainWindowTitle -like "*$escapedWindowTitle*") } | Select-Object -First 1',
		"  if ($matchingProcess) { $handle = $matchingProcess.MainWindowHandle.ToInt64() }",
		"}",
		"if ($handle -le 0) { exit 1 }",
		"$rect = New-Object RecordlyWindowBounds+RECT",
		"[RecordlyWindowBounds]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null",
		"$dwmResult = [RecordlyWindowBounds]::DwmGetWindowAttribute([IntPtr]$handle, 9, [ref]$rect, [Runtime.InteropServices.Marshal]::SizeOf($rect))",
		"if ($dwmResult -ne 0 -and -not [RecordlyWindowBounds]::GetWindowRect([IntPtr]$handle, [ref]$rect)) { exit 1 }",
		"@{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } | ConvertTo-Json -Compress",
	].join("\n");

	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-Command", script],
			{
				timeout: 5000,
				env: {
					...process.env,
					RECORDLY_WINDOW_ID: String(windowId ?? ""),
					RECORDLY_WINDOW_TITLE: windowTitle,
				},
			},
		);
		const bounds = JSON.parse(stdout) as WindowBounds;
		if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

		const electronScreen = getScreen();
		return typeof electronScreen.screenToDipPoint === "function"
			? convertPhysicalBoundsToDip(bounds, (point) => electronScreen.screenToDipPoint(point))
			: bounds;
	} catch {
		return null;
	}
}
