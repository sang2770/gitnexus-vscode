import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { getOutputChannel } from './cli-runner.js';

const LAST_CHECK_KEY = 'codebrain.updateCheck.lastCheckMs';
const DISMISSED_RELEASE_KEY = 'codebrain.updateCheck.dismissedRelease';
const DEFAULT_INTERVAL_HOURS = 24;
const REQUEST_TIMEOUT_MS = 15000;

interface UpdateCheckOptions {
  force?: boolean;
}

interface GitHubRepository {
  owner: string;
  repo: string;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  assets?: GitHubReleaseAsset[];
}

interface ExtensionPackageJson {
  name?: string;
  displayName?: string;
  version?: string;
  repository?: string | { url?: string };
}

interface HttpResponse {
  statusCode: number;
  body: Buffer;
}

export async function checkForExtensionUpdates(
  context: vscode.ExtensionContext,
  options: UpdateCheckOptions = {},
): Promise<void> {
  const channel = getOutputChannel();
  const config = vscode.workspace.getConfiguration('codebrain.updateCheck');
  const enabled = config.get<boolean>('enabled', true);
  const force = options.force === true;

  if (!enabled && !force) {
    return;
  }

  const intervalHours = Math.max(1, config.get<number>('intervalHours', DEFAULT_INTERVAL_HOURS));
  const lastCheckMs = context.globalState.get<number>(LAST_CHECK_KEY, 0);
  if (!force && Date.now() - lastCheckMs < intervalHours * 60 * 60 * 1000) {
    return;
  }

  try {
    await context.globalState.update(LAST_CHECK_KEY, Date.now());
    const pkg = context.extension.packageJSON as ExtensionPackageJson;
    const currentVersion = pkg.version;
    const repository = parseGitHubRepository(pkg.repository);
    if (!currentVersion || !repository) {
      if (force) {
        vscode.window.showWarningMessage('CodeBrain: Could not determine current version or GitHub repository.');
      }
      return;
    }

    const release = await fetchLatestRelease(repository);
    const latestVersion = normalizeVersion(release.tag_name ?? release.name ?? '');
    if (!latestVersion) {
      if (force) {
        vscode.window.showWarningMessage('CodeBrain: Could not parse the latest GitHub release version.');
      }
      return;
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (force) {
        vscode.window.showInformationMessage(`CodeBrain: You are up to date (v${currentVersion}).`);
      }
      return;
    }

    const dismissedRelease = context.globalState.get<string>(DISMISSED_RELEASE_KEY);
    if (!force && dismissedRelease === (release.tag_name ?? latestVersion)) {
      return;
    }

    await confirmAndInstallUpdate(context, {
      currentVersion,
      latestVersion,
      packageName: pkg.name ?? 'codebrain-vscode',
      displayName: pkg.displayName ?? 'CodeBrain',
      release,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`[CodeBrain] Update check failed: ${message}`);
    if (force) {
      vscode.window.showWarningMessage(`CodeBrain: Update check failed. ${message}`);
    }
  }
}

export async function checkForExtensionUpdatesCommand(context: vscode.ExtensionContext): Promise<void> {
  await checkForExtensionUpdates(context, { force: true });
}

async function confirmAndInstallUpdate(
  context: vscode.ExtensionContext,
  input: {
    currentVersion: string;
    latestVersion: string;
    packageName: string;
    displayName: string;
    release: GitHubRelease;
  },
): Promise<void> {
  const releaseTag = input.release.tag_name ?? `v${input.latestVersion}`;
  const releaseUrl = input.release.html_url;
  const vsixAsset = pickVsixAsset(input.release.assets ?? [], input.packageName);
  const installLabel = vsixAsset ? 'Install Update' : undefined;
  const releaseLabel = releaseUrl ? 'Release Notes' : undefined;
  const laterLabel = 'Later';
  const actions = [installLabel, releaseLabel, laterLabel].filter((action): action is string => Boolean(action));
  const prompt = vsixAsset
    ? `${input.displayName} v${input.latestVersion} is available. Current version: v${input.currentVersion}.`
    : `${input.displayName} v${input.latestVersion} is available, but this release has no VSIX asset. Current version: v${input.currentVersion}.`;

  const choice = await vscode.window.showInformationMessage(
    prompt,
    ...actions,
  );

  if (choice === laterLabel) {
    await context.globalState.update(DISMISSED_RELEASE_KEY, releaseTag);
    return;
  }

  if (choice === releaseLabel && releaseUrl) {
    await vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
    return;
  }

  if (choice !== installLabel || !vsixAsset?.browser_download_url) {
    return;
  }

  await installReleaseAsset(context, input.displayName, vsixAsset);
}

async function installReleaseAsset(
  context: vscode.ExtensionContext,
  displayName: string,
  asset: GitHubReleaseAsset,
): Promise<void> {
  const fileName = sanitizeFileName(asset.name ?? `${displayName}.vsix`);
  const updatesDir = path.join(context.globalStorageUri.fsPath, 'updates');
  const destination = path.join(updatesDir, fileName);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `CodeBrain: Downloading ${fileName}...`,
      cancellable: false,
    },
    async () => {
      await fsp.mkdir(updatesDir, { recursive: true });
      await downloadFile(asset.browser_download_url!, destination);
    },
  );

  try {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(destination));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const open = await vscode.window.showErrorMessage(
      `CodeBrain: Could not install downloaded VSIX. ${message}`,
      'Open VSIX Folder',
    );
    if (open === 'Open VSIX Folder') {
      await vscode.env.openExternal(vscode.Uri.file(updatesDir));
    }
    return;
  }

  const reload = await vscode.window.showInformationMessage(
    `CodeBrain: ${displayName} update installed. Reload VS Code to activate it.`,
    'Reload Now',
    'Later',
  );
  if (reload === 'Reload Now') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function fetchLatestRelease(repository: GitHubRepository): Promise<GitHubRelease> {
  const response = await httpGet(
    `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`,
    { Accept: 'application/vnd.github+json', 'User-Agent': 'CodeBrain-VSCode' },
  );

  if (response.statusCode === 404) {
    throw new Error('No GitHub release found for this repository.');
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`GitHub releases API returned HTTP ${response.statusCode}.`);
  }

  return JSON.parse(response.body.toString('utf-8')) as GitHubRelease;
}

function httpGet(url: string, headers: Record<string, string>, redirects = 0): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const location = res.headers.location;
      const statusCode = res.statusCode ?? 0;
      if (isRedirect(statusCode) && location && redirects < 5) {
        res.resume();
        resolve(httpGet(new URL(location, url).toString(), headers, redirects + 1));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ statusCode, body: Buffer.concat(chunks) });
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timed out.'));
    });
    req.on('error', reject);
  });
}

async function downloadFile(url: string, destination: string, redirects = 0): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'CodeBrain-VSCode' } },
      (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode ?? 0;
        if (isRedirect(statusCode) && location && redirects < 5) {
          res.resume();
          downloadFile(new URL(location, url).toString(), destination, redirects + 1)
            .then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`Download returned HTTP ${statusCode}.`));
          return;
        }

        const stream = fs.createWriteStream(destination);
        res.pipe(stream);
        stream.on('finish', () => {
          stream.close();
          resolve();
        });
        stream.on('error', reject);
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Download timed out.'));
    });
    req.on('error', reject);
  });
}

function parseGitHubRepository(repository: ExtensionPackageJson['repository']): GitHubRepository | undefined {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) {
    return undefined;
  }

  const match = url.match(/github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[#?].*)?$/iu);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

function pickVsixAsset(assets: GitHubReleaseAsset[], packageName: string): GitHubReleaseAsset | undefined {
  const vsixAssets = assets.filter((asset) => asset.name?.toLowerCase().endsWith('.vsix') && asset.browser_download_url);
  return (
    vsixAssets.find((asset) => asset.name?.toLowerCase().includes(packageName.toLowerCase())) ??
    vsixAssets[0]
  );
}

function normalizeVersion(value: string): string | undefined {
  const cleaned = value.trim().replace(/^v/iu, '');
  if (/^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/u.test(cleaned)) {
    return cleaned;
  }

  return value.match(/v?(\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)/iu)?.[1];
}

function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);

  for (let index = 0; index < 3; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  if (left.preRelease === right.preRelease) {
    return 0;
  }
  if (!left.preRelease) {
    return 1;
  }
  if (!right.preRelease) {
    return -1;
  }
  return left.preRelease.localeCompare(right.preRelease);
}

function splitVersion(value: string): { core: number[]; preRelease?: string } {
  const [mainAndPreRelease = ''] = value.split('+', 2);
  const [main = '', preRelease] = mainAndPreRelease.split('-', 2);
  return {
    core: main.split('.').map((part) => Number.parseInt(part, 10) || 0),
    preRelease,
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/gu, '_');
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}
