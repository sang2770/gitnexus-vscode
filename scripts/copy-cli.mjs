import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'codegraph');
const runtimeRoot = path.join(projectRoot, 'runtime', 'codegraph');
const sourceDist = path.join(sourceRoot, 'dist');

const NODE_VERSION = process.env.CODEGRAPH_BUNDLE_NODE_VERSION ?? 'v24.16.0';
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

function download(url, destination, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'codebrain-codegraph-bundler' }, timeout: 30000 },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects while downloading ${url}`));
            return;
          }
          download(new URL(response.headers.location, url).toString(), destination, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new Error(`download failed with HTTP ${status}: ${url}`));
          return;
        }

        const file = fs.createWriteStream(destination);
        response.on('error', reject);
        file.on('error', reject);
        file.on('finish', () => file.close(resolve));
        response.pipe(file);
      },
    );

    request.on('timeout', () => request.destroy(new Error(`download timed out: ${url}`)));
    request.on('error', reject);
  });
}

async function downloadNodeRuntime(target, workDir) {
  const [platform, arch] = target.split('-');
  const nodeDir = path.join(workDir, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });

  if (platform === 'win32') {
    const distName = `node-${NODE_VERSION}-win-${arch}`;
    const archive = path.join(workDir, 'node.zip');
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${distName}.zip`;
    console.log(`  Downloading ${url}`);
    await download(url, archive);
    run('tar', ['-xf', archive, '-C', nodeDir, '--strip-components=1']);
    return path.join(nodeDir, 'node.exe');
  }

  const distName = `node-${NODE_VERSION}-${target}`;
  const archive = path.join(workDir, 'node.tar.gz');
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${distName}.tar.gz`;
  console.log(`  Downloading ${url}`);
  await download(url, archive);
  run('tar', ['-xzf', archive, '-C', nodeDir, '--strip-components=1']);
  return path.join(nodeDir, 'bin', 'node');
}

function writeLauncher(target) {
  const [platform] = target.split('-');
  const binDir = path.join(runtimeRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  if (platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, 'codegraph.cmd'),
      '@"%~dp0..\\node.exe" --liftoff-only "%~dp0..\\lib\\dist\\bin\\codegraph.js" %*\r\n',
      'utf-8',
    );
    return;
  }

  const launcherPath = path.join(binDir, 'codegraph');
  fs.writeFileSync(
    launcherPath,
    [
      '#!/bin/sh',
      'SELF="$0"',
      'while [ -L "$SELF" ]; do',
      '  target="$(readlink "$SELF")"',
      '  case "$target" in',
      '    /*) SELF="$target" ;;',
      '    *) SELF="$(dirname "$SELF")/$target" ;;',
      '  esac',
      'done',
      'DIR="$(cd "$(dirname "$SELF")/.." && pwd)"',
      'exec "$DIR/node" --liftoff-only "$DIR/lib/dist/bin/codegraph.js" "$@"',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(launcherPath, 0o755);
}

async function main() {
  const target = process.env.CODEGRAPH_BUNDLE_TARGET ?? hostTarget();
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`Unsupported CodeGraph bundle target: ${target}`);
  }

  if (!fs.existsSync(path.join(sourceDist, 'bin', 'codegraph.js'))) {
    throw new Error('CodeGraph dist not found. Run npm --prefix codegraph run build first.');
  }

  console.log('Bundling self-contained CodeGraph runtime...');
  console.log(`  Target: ${target}`);
  console.log(`  Node: ${NODE_VERSION}`);
  console.log(`  Source: ${sourceRoot}`);
  console.log(`  Destination: ${runtimeRoot}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-runtime-'));
  try {
    const nodeBinary = await downloadNodeRuntime(target, workDir);
    if (!fs.existsSync(nodeBinary)) {
      throw new Error(`Downloaded Node runtime is missing: ${nodeBinary}`);
    }

    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(runtimeRoot, 'lib'), { recursive: true });

    const [platform] = target.split('-');
    const runtimeNode = path.join(runtimeRoot, platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(nodeBinary, runtimeNode);
    if (platform !== 'win32') {
      fs.chmodSync(runtimeNode, 0o755);
    }

    fs.cpSync(sourceDist, path.join(runtimeRoot, 'lib', 'dist'), { recursive: true });
    copySourceFile('package.json', path.join(runtimeRoot, 'lib'));
    copySourceFile('package-lock.json', path.join(runtimeRoot, 'lib'));

    console.log('  Installing production dependencies...');
    const npm = npmInvocation(['ci', '--omit=dev', '--ignore-scripts']);
    run(npm.command, npm.args, { cwd: path.join(runtimeRoot, 'lib') });
    fs.rmSync(path.join(runtimeRoot, 'lib', 'package-lock.json'), { force: true });

    writeLauncher(target);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log('CodeGraph self-contained runtime bundled successfully.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
