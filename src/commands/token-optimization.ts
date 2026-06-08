import * as vscode from 'vscode';
import type { TokenOptimizationMode } from '../process/token-optimizer.js';

const MODE_ITEMS: Array<vscode.QuickPickItem & { mode: TokenOptimizationMode }> = [
  {
    label: 'Auto',
    description: 'Use each workflow default',
    detail: 'Explain uses compact, impact/review/fix/test use balanced, architecture uses full.',
    mode: 'auto',
  },
  {
    label: 'Compact',
    description: 'Minimize tokens',
    detail: 'Use smaller history, fewer query results, and compact context estimates.',
    mode: 'compact',
  },
  {
    label: 'Balanced',
    description: 'Recommended',
    detail: 'Keep enough callers/dependencies for impact and review while controlling context size.',
    mode: 'balanced',
  },
  {
    label: 'Full',
    description: 'Broader context',
    detail: 'Use larger history and more query results for architecture and larger changes.',
    mode: 'full',
  },
  {
    label: 'Off',
    description: 'Disable token reduction',
    detail: 'Keep estimates visible but do not reduce context by mode.',
    mode: 'off',
  },
];

export async function selectTokenOptimizationModeCommand(): Promise<void> {
  const current = vscode.workspace
    .getConfiguration('codebrain.tokenOptimization')
    .get<string>('mode', 'auto');
  const picked = await vscode.window.showQuickPick(
    MODE_ITEMS.map((item) => ({
      ...item,
      picked: item.mode === current,
    })),
    {
      title: 'CodeBrain Token Optimization',
      placeHolder: 'Choose context/token optimization mode',
    },
  );

  if (!picked) {
    return;
  }

  await vscode.workspace
    .getConfiguration('codebrain.tokenOptimization')
    .update('mode', picked.mode, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage(`CodeBrain: Token optimization mode set to ${picked.mode}.`);
}
