import * as vscode from "vscode";
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOptions {
  cwd?: string;
  stream?: boolean;
  token?: vscode.CancellationToken;
  env?: Record<string, string>;
}

export interface CodeGraphRuntimeDescriptor {
  command: string;
  args: string[];
  shell: boolean;
  runtimeRoot: string;
  kind: "bundled" | "development";
}

let _outputChannel: vscode.OutputChannel | undefined;
let _extensionStorageRoot: string | undefined;
let _cliBuildPromise: Thenable<boolean> | undefined;

const CLI_SETUP_STATE_FILE = ".codebrain-codegraph-setup-done";
const ANSI_ESCAPE_SEQUENCE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function sanitizeOutputForChannel(text: string): string {
  // Strip ANSI CSI sequences and normalize carriage-return progress updates.
  return text.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "").replace(/\r(?!\n)/gu, "\n");
}

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
  const root =
    _extensionStorageRoot ??
    path.join(path.resolve(__dirname, "..", ".."), "runtime", "codegraph");
  return path.join(root, CLI_SETUP_STATE_FILE);
}

function getExtensionRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function getBundledRuntimeRoot(): string {
  return path.join(getExtensionRoot(), "runtime", "codegraph");
}

function getDevelopmentCliPath(): string {
  return path.join(getExtensionRoot(), "codegraph", "dist", "bin", "codegraph.js");
}

function getDevelopmentCodeGraphRoot(): string {
  return path.join(getExtensionRoot(), "codegraph");
}

function getBundledRuntimeDescriptor(args: string[]): CodeGraphRuntimeDescriptor | null {
  const runtimeRoot = getBundledRuntimeRoot();

  if (process.platform === "win32") {
    const nodeExe = path.join(runtimeRoot, "node.exe");
    const entry = path.join(runtimeRoot, "lib", "dist", "bin", "codegraph.js");
    if (fs.existsSync(nodeExe) && fs.existsSync(entry)) {
      return {
        command: nodeExe,
        args: ["--liftoff-only", entry, ...args],
        shell: false,
        runtimeRoot,
        kind: "bundled",
      };
    }
    return null;
  }

  const launcher = path.join(runtimeRoot, "bin", "codegraph");
  if (fs.existsSync(launcher)) {
    return {
      command: launcher,
      args,
      shell: false,
      runtimeRoot,
      kind: "bundled",
    };
  }

  return null;
}

function getDevelopmentRuntimeDescriptor(args: string[]): CodeGraphRuntimeDescriptor | null {
  const cliPath = getDevelopmentCliPath();
  if (!fs.existsSync(cliPath)) {
    return null;
  }

  return {
    command: "node",
    args: ["--liftoff-only", cliPath, ...args],
    shell: false,
    runtimeRoot: getDevelopmentCodeGraphRoot(),
    kind: "development",
  };
}

export function getCodeGraphRuntimeDescriptor(args: string[] = []): CodeGraphRuntimeDescriptor | null {
  return getBundledRuntimeDescriptor(args) ?? getDevelopmentRuntimeDescriptor(args);
}

export function hasBundledCodeGraphRuntime(): boolean {
  return Boolean(getBundledRuntimeDescriptor([]));
}

export function getInstalledCliVersion(): string | undefined {
  const descriptor = getCodeGraphRuntimeDescriptor();
  if (!descriptor) {
    return undefined;
  }

  const candidates = [
    path.join(descriptor.runtimeRoot, "lib", "package.json"),
    path.join(descriptor.runtimeRoot, "package.json"),
  ];
  const packageJsonPath = candidates.find((candidate) => fs.existsSync(candidate));

  try {
    if (!packageJsonPath) {
      return undefined;
    }
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function buildSpawnDescriptor(args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const descriptor = getCodeGraphRuntimeDescriptor(args);
  if (!descriptor) {
    throw new Error(
      "CodeGraph runtime not found. Run npm run build, or rebuild the extension package.",
    );
  }

  return descriptor;
}

function quoteForShell(arg: string): string {
  if (arg.length === 0 || /[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

export function buildCodeBrainTerminalCommand(args: string[]): string {
  const descriptor = buildSpawnDescriptor(args);
  return [descriptor.command, ...descriptor.args].map(quoteForShell).join(" ");
}

export function resolveNpmBin(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["npm"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      result
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    );
  } catch {
    return null;
  }
}

export function resolveNodeVersion(): string | null {
  try {
    return execFileSync("node", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export async function runCodeBrain(
  args: string[],
  opts: SpawnOptions = {},
): Promise<CliRunResult> {
  const channel = getOutputChannel();
  const ready = await ensureCodeBrainCliInstalled(opts.token);
  if (!ready) {
    const message = "CodeGraph runtime is unavailable.";
    channel.appendLine(`\n$ codegraph ${args.join(" ")}`);
    channel.appendLine(`[process error: ${message}]`);
    return { stdout: "", stderr: message, exitCode: 1 };
  }

  let descriptor;
  try {
    descriptor = buildSpawnDescriptor(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n$ codegraph ${args.join(" ")}`);
    channel.appendLine(`[process error: ${message}]`);
    return { stdout: "", stderr: message, exitCode: 1 };
  }

  const cwd = opts.cwd ?? getWorkspaceRoot();
  const env = { ...process.env, ...(opts.env ?? {}) };

  channel.appendLine(`\n$ codegraph ${args.join(" ")}`);
  channel.appendLine(`  cwd: ${cwd}`);
  channel.appendLine(`  exec: ${descriptor.command} ${descriptor.args.join(" ")}`);

  return new Promise<CliRunResult>((resolve) => {
    const proc = spawn(descriptor.command, descriptor.args, {
      cwd,
      env,
      shell: descriptor.shell,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.stream !== false) {
        channel.append(sanitizeOutputForChannel(text));
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.stream !== false) {
        channel.append(sanitizeOutputForChannel(text));
      }
    });

    opts.token?.onCancellationRequested(() => {
      proc.kill("SIGTERM");
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      channel.appendLine(`\n[codegraph exited: ${exitCode}]`);
      resolve({ stdout, stderr, exitCode });
    });

    proc.on("error", (err) => {
      channel.appendLine(`\n[process error: ${err.message}]`);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

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
      windowsHide: true,
    });

    proc.stdout?.on("data", (chunk: Buffer) =>
      channel.append(sanitizeOutputForChannel(chunk.toString())),
    );
    proc.stderr?.on("data", (chunk: Buffer) =>
      channel.append(sanitizeOutputForChannel(chunk.toString())),
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

export async function installCodeBrainCli(
  token?: vscode.CancellationToken,
): Promise<boolean> {
  const channel = getOutputChannel();
  channel.show(true);

  const sourceRoot = getDevelopmentCodeGraphRoot();
  if (!fs.existsSync(path.join(sourceRoot, "package.json"))) {
    channel.appendLine("[CodeGraph] Local CodeGraph source is not available.");
    return hasBundledCodeGraphRuntime();
  }

  const npm = resolveNpmBin();
  if (!npm) {
    channel.appendLine("[CodeGraph] npm not found. Install Node.js/npm first.");
    return false;
  }

  const npmCmd = process.platform === "win32" ? "cmd" : npm;
  const ciArgs =
    process.platform === "win32" ? ["/c", npm, "ci"] : ["ci"];
  const buildArgs =
    process.platform === "win32"
      ? ["/c", npm, "run", "build"]
      : ["run", "build"];

  try {
    channel.appendLine(`\n[CodeGraph] Building local CodeGraph from ${sourceRoot}`);
    await runCommand(npmCmd, ciArgs, sourceRoot, channel, token);
    await runCommand(npmCmd, buildArgs, sourceRoot, channel, token);
    channel.appendLine("[CodeGraph] Bundling self-contained runtime...");
    const bundleArgs =
      process.platform === "win32"
        ? ["/c", npm, "run", "bundle:cli"]
        : ["run", "bundle:cli"];
    await runCommand(npmCmd, bundleArgs, getExtensionRoot(), channel, token);
    const ok = Boolean(getBundledRuntimeDescriptor([]));
    channel.appendLine(
      ok
        ? "[CodeGraph] Bundled is ready."
        : "[CodeGraph] Build completed but bundled was not found.",
    );
    return ok;
  } catch (err) {
    channel.appendLine(
      `[CodeGraph] Build failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function ensureCodeBrainCliInstalled(
  token?: vscode.CancellationToken,
): Promise<boolean> {
  if (hasBundledCodeGraphRuntime()) {
    return true;
  }

  if (_cliBuildPromise) {
    return _cliBuildPromise;
  }

  const buildPromise = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "CodeBrain: Preparing CodeGraph...",
      cancellable: false,
    },
    () => installCodeBrainCli(token),
  );
  _cliBuildPromise = buildPromise;
  const result = await buildPromise;
  _cliBuildPromise = undefined;
  return result || Boolean(getDevelopmentRuntimeDescriptor([]));
}

export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
