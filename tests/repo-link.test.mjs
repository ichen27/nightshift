import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRepoLink, LinkError } from '../src/repo-link.mjs';

for (const link of [
  'https://github.com/octo/app',
  'https://github.com/octo/app/',
  'https://github.com/octo/app.git',
  'https://github.com/octo/app/tree/main/src',
  'git@github.com:octo/app.git',
  'octo/app',
  '  https://github.com/octo/app  ',
  'http://github.com/octo/app',
  'https://www.github.com/octo/app',
  'github.com/octo/app',
  'https://github.com/octo/app?tab=readme-ov-file#usage',
  'https://github.com/octo/app/pull/12',
  'ssh://git@github.com/octo/app.git',
]) {
  test(`parses ${link}`, () => assert.deepEqual(parseRepoLink(link), { owner: 'octo', repo: 'app' }));
}

for (const bad of [
  '',
  'octo',
  'https://gitlab.com/octo/app',
  'https://github.com/octo',
  'not a link',
  'https://github.com.evil.example/octo/app',
  'https://evil.example/github.com/octo/app',
  'octo/app/extra',
  'octo/..',
  '-octo/app',
  'octo/app name',
  'https://github.com/octo/app\nhttps://github.com/octo/other',
]) {
  test(`rejects ${JSON.stringify(bad)}`, () =>
    assert.throws(() => parseRepoLink(bad), { message: "That isn't a GitHub repository link." }));
}

test('rejects values that are not text', () => {
  for (const bad of [undefined, null, 42, {}, ['octo/app']]) {
    assert.throws(() => parseRepoLink(bad), LinkError);
  }
});

test('keeps dots, dashes and underscores in the repository name', () => {
  assert.deepEqual(parseRepoLink('https://github.com/octo-org/my_app.js'), { owner: 'octo-org', repo: 'my_app.js' });
  assert.deepEqual(parseRepoLink('octo/app.git.git'), { owner: 'octo', repo: 'app.git' });
});
