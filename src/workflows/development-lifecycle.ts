import type { CodeBrainWorkflowKind } from './intent-resolver.js';

export interface WorkflowFollowup {
  prompt: string;
  label: string;
}

export function getWorkflowFollowups(
  workflow: CodeBrainWorkflowKind | undefined,
  target: string | undefined,
): WorkflowFollowup[] {
  const safeTarget = target?.trim() || 'current context';

  if (workflow === 'develop' || workflow === 'fix') {
    return [
      { prompt: `/verify ${safeTarget}`, label: 'Verify the change' },
      { prompt: '/review', label: 'Review working tree' },
    ];
  }

  if (workflow === 'verify') {
    const impactFollowup = /\b(diff|changes?|working tree)\b/iu.test(safeTarget)
      ? { prompt: '/detect_change', label: 'Check change impact' }
      : { prompt: `/impact ${safeTarget}`, label: 'Check remaining impact' };
    return [
      { prompt: '/review', label: 'Review working tree' },
      impactFollowup,
    ];
  }

  if (workflow === 'plan') {
    return [{ prompt: `/develop ${safeTarget}`, label: 'Start development workflow' }];
  }

  return [
    { prompt: `/develop ${safeTarget}`, label: 'Develop safely' },
    { prompt: `/fix ${safeTarget}`, label: 'Diagnose a bug' },
    { prompt: `/verify ${safeTarget}`, label: 'Verify changes' },
  ];
}
