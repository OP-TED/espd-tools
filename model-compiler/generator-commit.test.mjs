// generatorCommit: the commit of the compiler is recorded only when it is the whole truth.
// Uses throw-away git repositories; needs the git command, no other input.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generatorCommit, COMMIT_PATTERN } from './generator-commit.mjs';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-commit-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

// The user's git configuration is not read (an empty file stands in for it, as the null device is not accepted on every
// platform) and nothing is written to it: the identity comes from the environment.
const emptyConfig = path.join(work, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const repo = path.join(work, 'repo');
const compiler = path.join(repo, 'compiler');
fs.mkdirSync(compiler, { recursive: true });
fs.mkdirSync(path.join(repo, 'other'));
fs.writeFileSync(path.join(compiler, 'a.mjs'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repo, 'other', 'b.txt'), 'b\n');
git(repo, 'init', '-q');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'first');
const head = git(repo, 'rev-parse', 'HEAD');

test('a clean checkout gives the full commit hash', () => {
  assert.equal(generatorCommit(compiler).commit, head);
  assert.match(head, COMMIT_PATTERN);
});

test('a change inside the compiler folder (edited or new file) means no commit is recorded', () => {
  fs.writeFileSync(path.join(compiler, 'a.mjs'), 'export const a = 2;\n');
  assert.deepEqual(generatorCommit(compiler), { commit: undefined, reason: 'it has uncommitted changes' });
  git(repo, 'checkout', '--', '.');
  assert.equal(generatorCommit(compiler).commit, head, 'clean again');

  fs.writeFileSync(path.join(compiler, 'new.mjs'), '\n');
  assert.equal(generatorCommit(compiler).commit, undefined, 'an untracked file counts too');
  fs.rmSync(path.join(compiler, 'new.mjs'));
});

test('a change elsewhere in the repository does not matter', () => {
  fs.writeFileSync(path.join(repo, 'other', 'b.txt'), 'changed\n');
  assert.equal(generatorCommit(compiler).commit, head);
  git(repo, 'checkout', '--', '.');
});

test('a folder that is not a git checkout gives no commit, and says why', () => {
  const plain = path.join(work, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(generatorCommit(plain), { commit: undefined, reason: 'it is not a git checkout' });
});

test('the commit pattern is a full lower-case hash', () => {
  assert.ok(COMMIT_PATTERN.test('a'.repeat(40)));
  for (const bad of ['', 'abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) assert.ok(!COMMIT_PATTERN.test(bad), bad);
});
