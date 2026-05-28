import * as vscode from "vscode";
import { execFile, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let _outputChannel: vscode.OutputChannel | undefined;
let _extensionStorageRoot: string | undefined;
let _cliInstallPromise: Thenable<boolean> | undefined;
let _latestVersionCache:
  | {
      value: string | null;
      checkedAt: number;
    }
  | undefined;

const CLI_PACKAGE_NAME = "@xuansang2770/gitnexus";
const CLI_INSTALL_FOLDER = "gitnexus-cli";
const CLI_SETUP_STATE_FILE = ".codebrain-cli-setup-done";
const CLI_VERSION_CHECK_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const CLI_VERSION_CHECK_FAILURE_TTL_MS = 10 * 60 * 1000;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel("CodeBrain");
  }
  return _outputChannel;
}

export function initializeCodeBrainRuntime(storageRoot: string): void {
  _extensionStorageRoot = storageRoot;
}

export function getSetupStateMarkerPath(): string {
  return path.join(getCliInstallRoot(), CLI_SETUP_STATE_FILE);
}

function getCliInstallRoot(): string {
  if (_extensionStorageRoot) {
    return path.join(_extensionStorageRoot, CLI_INSTALL_FOLDER);
  }
  const extensionRoot = path.resolve(__dirname, "..", "..");
  return path.join(extensionRoot, "runtime", "gitnexus");
}

function ensureCliInstallRoot(): void {
  fs.mkdirSync(getCliInstallRoot(), { recursive: true });
}

function getInstalledPackageJsonPath(): string {
  return path.join(
    getCliInstallRoot(),
    "node_modules",
    "@xuansang2770",
    "gitnexus",
    "package.json",
  );
}

export function getInstalledCliPath(): string | null {
  const installRoot = getCliInstallRoot();
  const candidates = [
    path.join(
      installRoot,
      "node_modules",
      "@xuansang2770",
      "gitnexus",
      "dist",
      "cli",
      "index.js",
    ),
    path.join(
      installRoot,
      "node_modules",
      "@xuansang2770",
      "gitnexus",
      "dist",
      "index.js",
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getInstalledCliVersion(): string | null {
  const pkgPath = getInstalledPackageJsonPath();
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestCliVersion(npm: string): Promise<string | null> {
  const execFileAsync = promisify(execFile);
  try {
    const command = process.platform === "win32" ? "cmd" : npm;
    const args =
      process.platform === "win32"
        ? ["/c", npm, "view", CLI_PACKAGE_NAME, "version", "--json"]
        : ["view", CLI_PACKAGE_NAME, "version", "--json"];

    const { stdout } = await execFileAsync(command, args, {
      cwd: getCliInstallRoot(),
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as string;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function getCachedLatestCliVersion(): string | null | undefined {
  if (!_latestVersionCache) {
    return undefined;
  }

  const ttl =
    _latestVersionCache.value === null
      ? CLI_VERSION_CHECK_FAILURE_TTL_MS
      : CLI_VERSION_CHECK_SUCCESS_TTL_MS;

  if (Date.now() - _latestVersionCache.checkedAt < ttl) {
    return _latestVersionCache.value;
  }

  return undefined;
}

function setCachedLatestCliVersion(value: string | null): void {
  _latestVersionCache = {
    value,
    checkedAt: Date.now(),
  };
}

/** Resolve the codebrain binary path from PATH, returns null if not found.
 *  On Windows, `where` returns the .cmd shim â€” we keep that path but mark it
 *  so callers know to use shell:true (or cmd /c) when spawning.
 */

/**
 * Build the spawn descriptor for running codebrain.
 * On Windows, .cmd shims cannot be spawned with shell:false â€” wrap via cmd /c.
 */
function buildSpawnDescriptor(args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const localCli = getInstalledCliPath();
  if (!localCli) {
    throw new Error("CodeBrain CLI not found. Run CodeBrain: Setup first.");
  }
  return { command: "node", args: [localCli, ...args], shell: false };
}

function quoteForShell(arg: string): string {
  if (arg.length === 0 || /[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/**
 * Build a shell command line using the same resolver strategy as runCodeBrain.
 * Useful for long-running commands that need to run in a VS Code terminal.
 */
export function buildCodeBrainTerminalCommand(args: string[]): string {
  const descriptor = buildSpawnDescriptor(args);
  return [descriptor.command, ...descriptor.args].map(quoteForShell).join(" ");
}

/** Check if npm is available; returns the resolved path or 'npm' for use with cmd /c */
export function resolveNpmBin(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["npm"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const bin = result
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return bin ?? null;
  } catch {
    return null;
  }
}

/** Check if node is available and meets minimum version */
export function resolveNodeVersion(): string | null {
  try {
    const result = execFileSync("node", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

export interface SpawnOptions {
  cwd?: string;
  /** Stream output to output channel in real time */
  stream?: boolean;
  /** CancellationToken to abort the process */
  token?: vscode.CancellationToken;
  /** Extra env vars */
  env?: Record<string, string>;
}

/**
 * Run a gitnexus CLI command.
 * Streams stdout/stderr to the Output Channel in real time.
 */
export async function runCodeBrain(
  args: string[],
  opts: SpawnOptions = {},
): Promise<CliRunResult> {
  const channel = getOutputChannel();
  const ready = await ensureCodeBrainCliInstalled(opts.token);
  if (!ready) {
    const message = "CodeBrain CLI install/update failed.";
    channel.appendLine(`\n$ codebrain ${args.join(" ")}`);
    channel.appendLine(`[process error: ${message}]`);
    return { stdout: "", stderr: message, exitCode: 1 };
  }

  let descriptor;
  try {
    descriptor = buildSpawnDescriptor(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n$ codebrain ${args.join(" ")}`);
    channel.appendLine(`[process error: ${message}]`);
    return { stdout: "", stderr: message, exitCode: 1 };
  }
  const cwd = opts.cwd ?? getWorkspaceRoot();
  const env = { ...process.env, ...(opts.env ?? {}) };

  channel.appendLine(`\n$ codebrain ${args.join(" ")}`);
  channel.appendLine(`  cwd: ${cwd}`);
  channel.appendLine(
    `  exec: ${descriptor.command} ${descriptor.args.join(" ")}`,
  );

  return new Promise<CliRunResult>((resolve) => {
    const { spawn } =
      require("child_process") as typeof import("child_process");
    const proc = spawn(descriptor.command, descriptor.args, {
      cwd,
      env,
      shell: descriptor.shell,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.stream !== false) {
        channel.append(text);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.stream !== false) {
        channel.append(text);
      }
    });

    opts.token?.onCancellationRequested(() => {
      proc.kill("SIGTERM");
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      channel.appendLine(`\n[gitnexus exited: ${exitCode}]`);
      resolve({ stdout, stderr, exitCode });
    });

    proc.on("error", (err) => {
      channel.appendLine(`\n[process error: ${err.message}]`);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

/**
 * Run npm install -g gitnexus and stream output.
 */
export async function installCodeBrainCli(
  token?: vscode.CancellationToken,
  options: { uninstallFirst?: boolean } = {},
): Promise<boolean> {
  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine(`\n$ Installing CodeBrain CLI...`);

  const npm = resolveNpmBin();
  if (!npm) {
    channel.appendLine("[ERROR] npm not found. Please install Node.js first.");
    return false;
  }

  ensureCliInstallRoot();
  const installRoot = getCliInstallRoot();
  const packageJsonPath = path.join(installRoot, "package.json");
  const npmCmd = process.platform === "win32" ? "cmd" : npm;
  const npmInitArgs =
    process.platform === "win32" ? ["/c", npm, "init", "-y"] : ["init", "-y"];
  const npmInstallArgs =
    process.platform === "win32"
      ? [
          "/c",
          npm,
          "install",
          "--no-save",
          "--no-audit",
          "--no-fund",
          `${CLI_PACKAGE_NAME}@latest`,
        ]
      : [
          "install",
          "--no-save",
          "--no-audit",
          "--no-fund",
          `${CLI_PACKAGE_NAME}@latest`,
        ];
  const npmUninstallArgs =
    process.platform === "win32"
      ? ["/c", npm, "uninstall", CLI_PACKAGE_NAME]
      : ["uninstall", CLI_PACKAGE_NAME];
  if (!fs.existsSync(packageJsonPath)) {
    // Step 1: Always run 'npm init -y'
    try {
      await runCommand(npmCmd, npmInitArgs, installRoot, channel, token);
    } catch (err) {
      channel.appendLine(
        `[ERROR] npm init -y failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  if (options.uninstallFirst) {
    // Force a clean update path: remove old package before installing latest.
    try {
      await runCommand(npmCmd, npmUninstallArgs, installRoot, channel, token);
    } catch (err) {
      channel.appendLine(
        `[ERROR] npm uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // Step 2: Run npm install
  try {
    await runCommand(npmCmd, npmInstallArgs, installRoot, channel, token);
    const ok = Boolean(getInstalledCliPath());
    channel.appendLine(
      ok
        ? "\n[CodeBrain CLI installed successfully]"
        : "\n[install failed: CLI not found after install]",
    );
    return ok;
  } catch (err) {
    channel.appendLine(
      `[ERROR] npm install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// Helper: run a command with async/await
async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  channel: vscode.OutputChannel,
  token?: vscode.CancellationToken,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: process.env,
      shell: false,
    });

    proc.stdout?.on("data", (chunk: Buffer) =>
      channel.append(chunk.toString()),
    );
    proc.stderr?.on("data", (chunk: Buffer) =>
      channel.append(chunk.toString()),
    );

    token?.onCancellationRequested(() => {
      try {
        proc.kill();
      } catch {}
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

export async function ensureCodeBrainCliInstalled(
  token?: vscode.CancellationToken,
): Promise<boolean> {
  const channel = getOutputChannel();
  const npm = resolveNpmBin();
  if (!npm) {
    return false;
  }

  ensureCliInstallRoot();

  const installedCli = getInstalledCliPath();
  if (!installedCli) {
    // CLI not installed - check if installation is already in progress
    if (_cliInstallPromise) {
      return _cliInstallPromise;
    }

    // Start new installation and cache the promise
    const installPromise = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CodeBrain: Installing CLI...",
        cancellable: false,
      },
      () => installCodeBrainCli(token),
    );
    _cliInstallPromise = installPromise;

    const result = await installPromise;
    _cliInstallPromise = undefined; // Clear cache after install completes
    return result;
  }

  const current = getInstalledCliVersion();
  const cachedLatest = getCachedLatestCliVersion();
  const latest =
    cachedLatest !== undefined ? cachedLatest : await getLatestCliVersion(npm);
  if (cachedLatest === undefined) {
    // Cache both successful and failed lookups to avoid repeated network waits.
    setCachedLatestCliVersion(latest);
  }
  if (!current || !latest) {
    return true;
  }

  if (current !== latest) {
    channel.appendLine(
      `[CodeBrain] Updating CLI from ${current} to ${latest}...`,
    );

    // Check if update is already in progress
    if (_cliInstallPromise) {
      return _cliInstallPromise;
    }

    // Start new update and cache the promise
    const updatePromise = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodeBrain: Updating CLI ${current} → ${latest}...`,
        cancellable: false,
      },
      () => installCodeBrainCli(token, { uninstallFirst: true }),
    );
    _cliInstallPromise = updatePromise;

    const result = await updatePromise;
    _cliInstallPromise = undefined; // Clear cache after update completes
    return result;
  }

  return true;
}

/** Return the first workspace folder root, or process.cwd(). */
export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
