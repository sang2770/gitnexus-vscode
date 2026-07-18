import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('short developer workflows are contributed to chat', () => {
  const participant = manifest.contributes.chatParticipants.find((item) => item.id === 'codebrain.codegraph');
  const commands = new Set(participant.commands.map((command) => command.name));
  assert.equal(commands.has('develop'), true);
  assert.equal(commands.has('fix'), true);
  assert.equal(commands.has('verify'), true);
});

test('clean install, lint, test, and package scripts are available to CI', () => {
  assert.match(manifest.scripts.lint, /eslint/u);
  assert.match(manifest.scripts.test, /node --test/u);
  assert.match(manifest.scripts.package, /vsce package/u);
});
