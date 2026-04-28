import * as vscode from 'vscode';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const RUNTIME_MARKER = '.runtime-initialized';
const execFileAsync = promisify(execFile);

let _installPromise: Promise<boolean> | null = null;

export interface EnsureRuntimeOptions {
  showProgress?: boolean;
  outputChannel?: vscode.OutputChannel;
}

function getRuntimeRoot(extensionRoot: string): string {
  return path.join(extensionRoot, 'runtime', 'gitnexus');
}

function hasInstalledRuntime(runtimeRoot: string): boolean {
  return fs.existsSync(path.join(runtimeRoot, 'node_modules'));
}

function hasRuntimeCli(runtimeRoot: string): boolean {
  return fs.existsSync(path.join(runtimeRoot, 'dist', 'cli', 'index.js'));
}

function resolveNpmCommand(): { command: string; argsPrefix: string[] } | null {
  if (process.platform === 'win32') {
    try {
      const result = execFileSync('where', ['npm.cmd'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const npmCmd = result
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!npmCmd) {
        return null;
      }
      return { command: 'cmd', argsPrefix: ['/c', npmCmd] };
    } catch {
      return null;
    }
  }

  try {
    execFileSync('which', ['npm'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { command: 'npm', argsPrefix: [] };
  } catch {
    return null;
  }
}

async function installRuntimeDependencies(runtimeRoot: string, output?: vscode.OutputChannel): Promise<boolean> {
  const packageJsonPath = path.join(runtimeRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    output?.appendLine('[GitNexus] runtime package.json not found.');
    return false;
  }

  if (!hasRuntimeCli(runtimeRoot)) {
    output?.appendLine('[GitNexus] runtime CLI not found. Rebuild extension runtime bundle.');
    return false;
  }

  const npm = resolveNpmCommand();
  if (!npm) {
    output?.appendLine('[GitNexus] npm not found in PATH.');
    return false;
  }

  const installArgs = [
    ...npm.argsPrefix,
    'install',
    '--omit=dev',
    '--no-save',
    '--no-audit',
    '--no-fund',
  ];

  try {
    output?.appendLine(`[GitNexus] Installing runtime dependencies in ${runtimeRoot}`);
    const { stdout, stderr } = await execFileAsync(npm.command, installArgs, {
      cwd: runtimeRoot,
      windowsHide: true,
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stdout) {
      output?.appendLine(stdout);
    }
    if (stderr) {
      output?.appendLine(stderr);
    }

    if (!hasInstalledRuntime(runtimeRoot)) {
      output?.appendLine('[GitNexus] npm install completed but node_modules is still missing.');
      return false;
    }

    fs.writeFileSync(path.join(runtimeRoot, RUNTIME_MARKER), Date.now().toString());
    output?.appendLine('[GitNexus] Runtime dependencies installed successfully.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output?.appendLine(`[GitNexus] Runtime install failed: ${message}`);
    return false;
  }
}

export async function ensureRuntimeDependencies(
  extensionRoot: string,
  options: EnsureRuntimeOptions = {},
): Promise<boolean> {
  const runtimeRoot = getRuntimeRoot(extensionRoot);
  const marker = path.join(runtimeRoot, RUNTIME_MARKER);

  // Already initialized in this session
  if (fs.existsSync(marker)) {
    return true;
  }

  // Check if node_modules exists
  if (hasInstalledRuntime(runtimeRoot)) {
    // Mark as initialized
    fs.writeFileSync(marker, Date.now().toString());
    return true;
  }

  if (_installPromise) {
    return _installPromise;
  }

  const runner = async (): Promise<boolean> => {
    if (options.showProgress) {
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'GitNexus: Installing runtime dependencies…',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Preparing runtime...' });
          const ok = await installRuntimeDependencies(runtimeRoot, options.outputChannel);
          progress.report({ message: ok ? 'Completed' : 'Failed' });
          return ok;
        },
      );
    }
    return installRuntimeDependencies(runtimeRoot, options.outputChannel);
  };

  _installPromise = runner();
  const ok = await _installPromise;
  _installPromise = null;
  return ok;
}
