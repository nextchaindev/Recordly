# Driving Recordly from an AI agent (MCP)

Recordly can expose a small **local control server** so an AI agent (Claude Code, Cursor,
Codex, any MCP client) can record, screenshot and operate the app directly instead of
guessing at pixels. The bundled **Recordly MCP server** wraps that control server as MCP
tools.

Why not plain computer-use? Recordly's HUD is deliberately hidden from screen capture
(`setContentProtection`), so a screenshot-driven agent cannot see the record bar. The
control server reads the HUD's own DOM and renders its own windows with
`webContents.capturePage`, which ignores capture protection.

## 1. Enable the control server

The server is **off by default**. Turn it on with any one of:

| Method | How |
| --- | --- |
| Environment variable | `RECORDLY_CONTROL_SERVER=1` |
| CLI flag | `Recordly.exe --control-server` (or `npm run dev -- --control-server` in dev) |
| App setting | add `"controlServerEnabled": true` to `app-settings.json` in the user-data folder |

When enabled, Recordly listens on `127.0.0.1` on a random port (override with
`RECORDLY_CONTROL_PORT`) and writes a discovery file:

| Platform | Discovery file |
| --- | --- |
| Windows | `%APPDATA%\Recordly\control-server.json` |
| macOS | `~/Library/Application Support/Recordly/control-server.json` |
| Linux | `~/.config/Recordly/control-server.json` |

Dev builds (`npm run dev`) use `Recordly-dev` instead of `Recordly`. The file holds the port
and a per-launch bearer token. Only loopback requests carrying that token are accepted, and
the file is removed on quit.

## 2. Register the MCP server

### Claude Desktop: one-click extension (.mcpb)

`npm run build:mcpb` produces `release/Recordly-MCP.mcpb`, a Claude Desktop extension
bundle. Double-click it (or Claude Desktop → Settings → Extensions → Advanced settings →
Install extension…) and Claude runs the server on its own Node runtime: no Node install,
no JSON editing. The server finds a running Recordly through the discovery file and can
launch a Recordly installed in the standard location itself; the optional "Recordly
executable" setting is only for unusual install paths. Extensions apply to Claude Desktop
chat; Claude Code, Cursor and others use the configs below.

### Installed app (no Node.js needed)

The Windows/macOS/Linux packages ship the MCP server at
`<install dir>/resources/mcp/recordly-mcp-server.mjs` and the installed Recordly
executable can run it as a Node process. On Windows the default install dir is
`%LOCALAPPDATA%\Programs\Recordly`, so for Claude Code:

```bash
claude mcp add recordly -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\Recordly\Recordly.exe" "%LOCALAPPDATA%\Programs\Recordly\resources\mcp\recordly-mcp-server.mjs"
```

or as JSON (Claude Code `.mcp.json`, Cursor, Windsurf, Codex all use this shape):

```json
{
	"mcpServers": {
		"recordly": {
			"command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Recordly\\Recordly.exe",
			"args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Recordly\\resources\\mcp\\recordly-mcp-server.mjs"],
			"env": { "ELECTRON_RUN_AS_NODE": "1" }
		}
	}
}
```

Then, with Recordly **closed**, ask the agent to call `recordly_launch` once. It starts
Recordly with the control server on and writes `controlServerEnabled: true` to
`app-settings.json`, so from then on starting Recordly normally (Start menu, taskbar) keeps
the server on. If Recordly is already running without the server, quit it first: close the HUD
bar with its X button (Windows and macOS have no tray icon; only Linux does).

### From the repository (Node 18+)

Claude Code (`.mcp.json` in the project, or `claude mcp add`):

```json
{
	"mcpServers": {
		"recordly": {
			"command": "node",
			"args": ["C:/path/to/Recordly/scripts/mcp/recordly-mcp-server.mjs"],
			"env": {
				"RECORDLY_APP_PATH": "C:/Users/you/AppData/Local/Programs/Recordly/Recordly.exe"
			}
		}
	}
}
```

Cursor / Windsurf / Codex use the same `command`/`args`/`env` shape in their MCP settings.

Optional environment for the MCP server:

- `RECORDLY_APP_PATH` – lets the `recordly_launch` tool start Recordly with the control
  server enabled when it is not running.
- `RECORDLY_CONTROL_FILE` – explicit discovery-file path (portable installs, custom user data).

## 3. Tools

| Tool | What it does |
| --- | --- |
| `recordly_status` | Recording/paused state, selected source, last video path, open windows. |
| `recordly_launch` | Start Recordly (needs `RECORDLY_APP_PATH`) if it is not reachable. |
| `recordly_list_sources` | Displays and application windows available for capture. |
| `recordly_select_source` | Pick a source by id, window title / app name, or `type=screen`. A window source records **only that window**, no desktop or taskbar. |
| `recordly_start_recording` | Start recording (optionally select a source and set mic / system audio / webcam / countdown first). |
| `recordly_stop_recording` | Stop, wait for the finalized file, optionally copy it to `saveAs`. With `fit` (e.g. `{"width":1280,"height":720,"cropTop":40}`) the copy is re-encoded with the bundled ffmpeg: title bar cropped, content letterboxed on black, exact size. |
| `recordly_pause_recording` / `recordly_resume_recording` / `recordly_cancel_recording` | Recording controls. |
| `recordly_capture_screenshot` | PNG of a display or of a single window (clean, no desktop). |
| `recordly_capture_window` | PNG of one of Recordly's own windows (HUD, editor). Works despite capture protection. |
| `recordly_ui_snapshot` | Interactive elements (refs, names, values, bounds) and visible text of a Recordly window. |
| `recordly_ui_click` / `recordly_ui_type` / `recordly_ui_key` / `recordly_ui_set_value` | Operate Recordly's UI by ref, selector, text or coordinates. |
| `recordly_show_hud` / `recordly_open_editor` / `recordly_close_editor` / `recordly_windows` | Window management. |

### Typical automation flow

```text
recordly_status
recordly_list_sources type=window
recordly_select_source name="Cursor"              # records only the Cursor window
recordly_start_recording countdownSeconds=0 microphoneEnabled=false
... drive the target app with computer-use / browser tools ...
recordly_stop_recording saveAs="D:/AI캡처/cursor/90_recording_agent_flow.mp4"
recordly_capture_screenshot name="Cursor" outputPath="D:/AI캡처/cursor/01_editor_home.png"
recordly_show_hud                                  # ready for the next recording
```

After `recordly_stop_recording` Recordly opens the editor with the new recording, exactly
like a manual stop. The raw file returned is the untouched capture; use the editor (or
`recordly_open_editor`) if you want Recordly's zooms, backgrounds or cropping applied.

## 4. Raw control protocol

Anything that can speak HTTP can use the server directly:

```http
POST http://127.0.0.1:<port>/rpc
Authorization: Bearer <token>
Content-Type: application/json

{"method": "sources.select", "params": {"name": "Cursor", "type": "window"}}
```

Responses are `{"ok": true, "result": ...}` or `{"ok": false, "error": {"code", "message"}}`.
Methods: `ping`, `status`, `windows.list`, `windows.capture`, `windows.focus`, `hud.show`,
`editor.open`, `editor.close`, `sources.list`, `sources.select`, `screen.capture`,
`recording.start|stop|pause|resume|cancel|waitForFile|preferences`, `ui.snapshot`,
`ui.click`, `ui.type`, `ui.key`, `ui.setValue`, and `renderer.command` (invoke any handler
registered with `registerControlCommands` in a renderer window).

## 5. Security notes

- Loopback only, random per-launch token, opt-in. Nothing is exposed on the network.
- The discovery file is written with mode `0600` where the platform supports it.
- Keep the server disabled on machines where other local users should not be able to
  drive Recordly.
