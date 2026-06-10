import * as vscode from "vscode";
import { spawn } from "child_process";
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
  void storageRoot;
}

export function getSetupStateMarkerPath(): string {
  return path.join(getBundledRuntimeRoot(), CLI_SETUP_STATE_FILE);
}

function getExtensionRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function getBundledRuntimeRoot(): string {
  return path.join(getExtensionRoot(), "runtime", "codegraph");
}

function getBundledRuntimeDescriptor(args: string[]): CodeGraphRuntimeDescriptor | null {
  const runtimeRoot = getBundledRuntimeRoot();
  const entry = path.join(runtimeRoot, "lib", "dist", "bin", "codegraph.js");
  const channel = getOutputChannel();
  if (!fs.existsSync(entry)) {
    channel.appendLine(`[CodeGraph runtime entry point not found at expected location: ${entry}]`);
    return null;
  }

  if (process.platform === "win32") {
    if (fs.existsSync(path.join(runtimeRoot, "bin", "codegraph.cmd"))) {
      return {
        command: "node",
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
  channel.appendLine(`[CodeGraph runtime launcher not found at expected location: ${launcher}]`);
  return null;
}

export function getCodeGraphRuntimeDescriptor(args: string[] = []): CodeGraphRuntimeDescriptor | null {
  return getBundledRuntimeDescriptor(args);
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
    throw new Error("Bundled CodeGraph runtime not found.");
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

export async function ensureCodeBrainCliInstalled(
  token?: vscode.CancellationToken,
): Promise<boolean> {
  void token;
  return true;
}

export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
