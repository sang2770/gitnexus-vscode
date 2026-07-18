import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesLocalizedWorkflow } from '../out/workflows/workflow-keywords.js';

test('Vietnamese feature requests route without an AI classifier call', () => {
  assert.equal(matchesLocalizedWorkflow('Triển khai tính năng session timeout', 'develop'), true);
});

test('Vietnamese bug and verification requests are recognized locally', () => {
  assert.equal(matchesLocalizedWorkflow('Sửa lỗi đăng nhập bị hỏng', 'fix'), true);
  assert.equal(matchesLocalizedWorkflow('Kiểm tra thay đổi trước khi merge', 'verify'), true);
});
