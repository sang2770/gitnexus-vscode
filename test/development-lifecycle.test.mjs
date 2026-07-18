import assert from 'node:assert/strict';
import test from 'node:test';
import { getWorkflowFollowups } from '../out/workflows/development-lifecycle.js';

test('develop continues to focused verification and review', () => {
  assert.deepEqual(getWorkflowFollowups('develop', 'AuthService.login'), [
    { prompt: '/verify AuthService.login', label: 'Verify the change' },
    { prompt: '/review', label: 'Review working tree' },
  ]);
});

test('verify continues to review and residual impact', () => {
  assert.deepEqual(getWorkflowFollowups('verify', 'working tree diff'), [
    { prompt: '/review', label: 'Review working tree' },
    { prompt: '/detect_change', label: 'Check change impact' },
  ]);
});

test('missing target uses a compact current-context fallback', () => {
  assert.equal(getWorkflowFollowups('fix', undefined)[0].prompt, '/verify current context');
});
