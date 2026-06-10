import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'codegraph');
const runtimeRoot = path.join(projectRoot, 'runtime', 'codegraph');
const sourceDist = path.join(sourceRoot, 'dist');

const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

function npmInvocation(args) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', ...args],
    };
  }

  return { command: 'npm', args };
}

function copySourceFile(name, destinationDir) {
  fs.copyFileSync(path.join(sourceRoot, name), path.join(destinationDir, name));
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
}

function writeLauncher() {
  const binDir = path.join(runtimeRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Windows
  fs.writeFileSync(
    path.join(binDir, 'codegraph.cmd'),
    '@node --liftoff-only "%~dp0..\\lib\\dist\\bin\\codegraph.js" %*\r\n',
    'utf-8',
  );

  // Linux / macOS
  const launcherPath = path.join(binDir, 'codegraph');
  fs.writeFileSync(
    launcherPath,
    `#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node --liftoff-only "$DIR/lib/dist/bin/codegraph.js" "$@"
`,
    'utf-8',
  );

  fs.chmodSync(launcherPath, 0o755);
}

function main() {
  const target = process.env.CODEGRAPH_BUNDLE_TARGET ?? hostTarget();
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Unsupported CodeGraph bundle target: ${target}`);
  }

  if (!fs.existsSync(path.join(sourceDist, 'bin', 'codegraph.js'))) {
    throw new Error('CodeGraph dist not found. Run npm --prefix codegraph run build first.');
  }

  console.log('Bundling self-contained CodeGraph runtime...');
  console.log(`  Target: ${target}`);
  console.log(`  Source: ${sourceRoot}`);
  console.log(`  Destination: ${runtimeRoot}`);

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(runtimeRoot, 'lib'), { recursive: true });

  fs.cpSync(sourceDist, path.join(runtimeRoot, 'lib', 'dist'), { recursive: true });
  copySourceFile('package.json', path.join(runtimeRoot, 'lib'));
  copySourceFile('package-lock.json', path.join(runtimeRoot, 'lib'));

  console.log('  Installing production dependencies...');
  const npm = npmInvocation(['ci', '--omit=dev', '--ignore-scripts']);
  run(npm.command, npm.args, { cwd: path.join(runtimeRoot, 'lib') });
  fs.rmSync(path.join(runtimeRoot, 'lib', 'package-lock.json'), { force: true });

  writeLauncher();

  console.log('CodeGraph self-contained runtime bundled successfully.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
