/**
 * Builds a Claude Desktop extension bundle (.mcpb) for the Recordly MCP server.
 *
 * The bundle is a zip with manifest.json at its root plus the dependency-free
 * server files. Claude Desktop installs it from Settings → Extensions (or by
 * double-clicking the file) and runs it on its own Node runtime, so the user
 * needs neither Node nor any JSON editing. The server finds a running Recordly
 * through the discovery file and can launch an installed Recordly itself.
 *
 * Output: release/Recordly-MCP.mcpb
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const { TOOL_DEFINITIONS } = await import(
	pathToFileURL(path.join(root, "scripts", "mcp", "lib", "tools.mjs")).href
);

const outputDir = path.join(root, "release");
const outputPath = path.join(outputDir, "Recordly-MCP.mcpb");
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "recordly-mcpb-"));

function copyServerFiles() {
	const serverSrc = path.join(root, "scripts", "mcp");
	const serverDst = path.join(stagingDir, "server");
	fs.mkdirSync(path.join(serverDst, "lib"), { recursive: true });
	fs.copyFileSync(
		path.join(serverSrc, "recordly-mcp-server.mjs"),
		path.join(serverDst, "recordly-mcp-server.mjs"),
	);
	for (const file of fs.readdirSync(path.join(serverSrc, "lib"))) {
		if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) {
			fs.copyFileSync(path.join(serverSrc, "lib", file), path.join(serverDst, "lib", file));
		}
	}
	// The server reads ../../package.json (relative to its own folder) for its version.
	fs.writeFileSync(
		path.join(stagingDir, "package.json"),
		JSON.stringify(
			{ name: "recordly-mcp", version: packageJson.version, type: "module" },
			null,
			2,
		),
	);
}

function copyIcon() {
	const icon = path.join(root, "public", "app-icons", "recordly-512.png");
	if (fs.existsSync(icon)) {
		fs.copyFileSync(icon, path.join(stagingDir, "icon.png"));
		return "icon.png";
	}
	return undefined;
}

function writeManifest(iconName) {
	const manifest = {
		manifest_version: "0.2",
		name: "recordly",
		display_name: "Recordly",
		version: packageJson.version,
		description:
			"Drive the Recordly screen recorder from Claude: record a single app window, take clean screenshots, and export clips with the cursor rendered.",
		long_description:
			"Requires the Recordly desktop app. Recordly starts with its local control server when launched " +
			"through the recordly_launch tool (or with --control-server); the extension then records, screenshots " +
			"and exports on your behalf. Everything stays on this computer: the control server listens on " +
			"127.0.0.1 with a per-launch token.",
		author: { name: packageJson.author ?? "Recordly", url: packageJson.homepage },
		homepage: packageJson.homepage,
		documentation: `${packageJson.homepage}/blob/main/docs/mcp-control.md`,
		license: "MIT",
		...(iconName ? { icon: iconName } : {}),
		server: {
			type: "node",
			entry_point: "server/recordly-mcp-server.mjs",
			mcp_config: {
				command: "node",
				args: ["${__dirname}/server/recordly-mcp-server.mjs"],
				env: {
					RECORDLY_APP_PATH: "${user_config.app_path}",
				},
			},
		},
		user_config: {
			app_path: {
				type: "file",
				title: "Recordly executable (optional)",
				description:
					"Only needed if Recordly is installed somewhere unusual. Standard installs are found automatically.",
				required: false,
				default: "",
			},
		},
		tools: TOOL_DEFINITIONS.map((tool) => ({ name: tool.name, description: tool.description })),
		keywords: ["screen recording", "recorder", "screenshot", "video", "automation"],
		compatibility: {
			claude_desktop: ">=0.10.0",
			platforms: ["win32", "darwin"],
			runtimes: { node: ">=18.0.0" },
		},
	};
	fs.writeFileSync(
		path.join(stagingDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

function zipStaging() {
	fs.mkdirSync(outputDir, { recursive: true });
	fs.rmSync(outputPath, { force: true });
	if (process.platform === "win32") {
		const zipPath = `${outputPath}.zip`;
		fs.rmSync(zipPath, { force: true });
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				`Compress-Archive -Path (Join-Path '${stagingDir}' '*') -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
			],
			{ stdio: "inherit" },
		);
		fs.renameSync(zipPath, outputPath);
	} else {
		execFileSync("zip", ["-qr", outputPath, "."], { cwd: stagingDir, stdio: "inherit" });
	}
}

copyServerFiles();
const iconName = copyIcon();
writeManifest(iconName);
zipStaging();
fs.rmSync(stagingDir, { recursive: true, force: true });
console.log(`[build-mcpb] Wrote ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
