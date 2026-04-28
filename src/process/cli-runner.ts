import * as vscode from 'vscode';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { ensureRuntimeDependencies } from './runtime-init.js';

const execFileAsync = promisify(execFile);

export interface CliEntry {
  command: string;
  args: string[];
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return Array.from(new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0)));
}

let _outputChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('GitNexus');
  }
  return _outputChannel;
}

/** Resolve the gitnexus binary path from PATH, returns null if not found.
 *  On Windows, `where` returns the .cmd shim — we keep that path but mark it
 *  so callers know to use shell:true (or cmd /c) when spawning.
 */
export function resolveGitnexusBin(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['gitnexus'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `where` can return multiple lines; take first non-empty
    const bin = result
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return bin ?? null;
  } catch {
    return null;
  }
}

/** Resolve local built CLI path when developing in a monorepo/workspace. */
export function resolveLocalGitnexusCliPath(baseDir?: string): string | null {
  // Walk up from __dirname (src/process) to the extension root
  const extensionRoot = baseDir ?? path.resolve(__dirname, '..', '..');
  const localCli = path.join(extensionRoot, 'GitNexus', 'gitnexus', 'dist', 'cli', 'index.js');
  return fs.existsSync(localCli) ? localCli : null;
}

export function resolveBundledGitnexusCliPath(baseDir?: string): string | null {
  const extensionRoot = baseDir ?? path.resolve(__dirname, '..', '..');
  const runtimeRoot = path.join(extensionRoot, 'runtime', 'gitnexus');
  const bundledCli = path.join(runtimeRoot, 'dist', 'cli', 'index.js');
  console.log(`Resolving bundled CLI at ${bundledCli}`);
  return fs.existsSync(bundledCli) ? bundledCli : null;
}

function resolvePreferredLocalCliPath(baseDir?: string): string | null {
  return resolveBundledGitnexusCliPath(baseDir) ?? resolveLocalGitnexusCliPath(baseDir);
}

/**
 * Resolve an MCP entry for VS Code mcp.json.
 * Runtime-only: use bundled CLI inside extension package.
 */
export function resolveMcpEntry(baseDir?: string): CliEntry {
  const bundledCli = resolveBundledGitnexusCliPath(baseDir);
  if (!bundledCli) {
    throw new Error('GitNexus bundled runtime CLI not found. Reinstall extension package or run npm run build && npm run package.');
  }
  return { command: 'node', args: [bundledCli, 'mcp'] };
}

/**
 * Build the spawn descriptor for running gitnexus.
 * On Windows, .cmd shims cannot be spawned with shell:false — wrap via cmd /c.
 */
function buildSpawnDescriptor(args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const localCli = resolvePreferredLocalCliPath();
  if (!localCli) {
    throw new Error('GitNexus local CLI is unavailable (runtime dependencies may have failed to install). Run: npm run build, then retry.');
  }
  return { command: 'node', args: [localCli, ...args], shell: false };
}

function quoteForShell(arg: string): string {
  if (arg.length === 0 || /[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/**
 * Build a shell command line using the same resolver strategy as runGitnexus.
 * Useful for long-running commands that need to run in a VS Code terminal.
 */
export function buildGitnexusTerminalCommand(args: string[]): string {
  const descriptor = buildSpawnDescriptor(args);
  return [descriptor.command, ...descriptor.args].map(quoteForShell).join(' ');
}

/** Check if npm is available; returns the resolved path or 'npm' for use with cmd /c */
export function resolveNpmBin(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['npm'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const bin = result
      .split('\n')
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
    const result = execFileSync('node', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
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
export async function runGitnexus(
  args: string[],
  opts: SpawnOptions = {},
): Promise<CliRunResult> {
  const channel = getOutputChannel();
  const extensionRoot = path.resolve(__dirname, '..', '..');
  const runtimeReady = await ensureRuntimeDependencies(extensionRoot, {
    showProgress: true,
    outputChannel: channel,
  });

  if (!runtimeReady && !resolveLocalGitnexusCliPath(extensionRoot)) {
    const message = 'GitNexus runtime dependency install failed. Check Output panel and run npm run build if needed.';
    channel.appendLine(`\n$ gitnexus ${args.join(' ')}`);
    channel.appendLine(`[process error: ${message}]`);
    return { stdout: '', stderr: message, exitCode: 1 };
  }

  let descriptor;
  try {
    descriptor = buildSpawnDescriptor(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n$ gitnexus ${args.join(' ')}`);
    channel.appendLine(`[process error: ${message}]`);
    return { stdout: '', stderr: message, exitCode: 1 };
  }
  const cwd = opts.cwd ?? getWorkspaceRoot();
  const env = { ...process.env, ...(opts.env ?? {}) };

  channel.appendLine(`\n$ gitnexus ${args.join(' ')}`);
  channel.appendLine(`  cwd: ${cwd}`);
  channel.appendLine(`  exec: ${descriptor.command} ${descriptor.args.join(' ')}`);

  return new Promise<CliRunResult>((resolve) => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const proc = spawn(descriptor.command, descriptor.args, {
      cwd,
      env,
      shell: descriptor.shell,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.stream !== false) {
        channel.append(text);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.stream !== false) {
        channel.append(text);
      }
    });

    opts.token?.onCancellationRequested(() => {
      proc.kill('SIGTERM');
    });

    proc.on('close', (code) => {
      const exitCode = code ?? 1;
      channel.appendLine(`\n[gitnexus exited: ${exitCode}]`);
      resolve({ stdout, stderr, exitCode });
    });

    proc.on('error', (err) => {
      channel.appendLine(`\n[process error: ${err.message}]`);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

/**
 * Run npm install -g gitnexus and stream output.
 */
export async function installGitnexusCli(token?: vscode.CancellationToken): Promise<boolean> {
  const channel = getOutputChannel();
  channel.show(true);
  channel.appendLine('\n$ npm install -g gitnexus  (installing GitNexus CLI globally)');

  const npm = resolveNpmBin();
  if (!npm) {
    channel.appendLine('[ERROR] npm not found. Please install Node.js first.');
    return false;
  }

  // On Windows, npm is a .cmd shim — must use cmd /c
  const spawnCmd = process.platform === 'win32' ? 'cmd' : npm;
  const spawnArgs =
    process.platform === 'win32'
      ? ['/c', npm, 'install', '-g', 'gitnexus']
      : ['install', '-g', 'gitnexus'];

  return new Promise<boolean>((resolve) => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const proc = spawn(spawnCmd, spawnArgs, {
      env: process.env,
      shell: false,
    });

    proc.stdout?.on('data', (chunk: Buffer) => channel.append(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => channel.append(chunk.toString()));

    token?.onCancellationRequested(() => proc.kill('SIGTERM'));

    proc.on('close', (code) => {
      const ok = code === 0;
      channel.appendLine(ok ? '\n[GitNexus CLI installed successfully]' : `\n[install failed: exit ${code}]`);
      resolve(ok);
    });

    proc.on('error', (err) => {
      channel.appendLine(`\n[npm error: ${err.message}]`);
      resolve(false);
    });
  });
}

/** Return the first workspace folder root, or process.cwd(). */
export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
