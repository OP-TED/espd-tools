// Which commit of the compiler built a model.
//
// The envelope records the exact commit of this folder, so a published model can be tied to the code that made
// it. A commit is only recorded when it is the whole truth: the folder is a git checkout and has no uncommitted
// changes. Otherwise the build is not reproducible from a commit, and none is recorded (the reason is returned
// so that the build can say so).

import { execFileSync } from 'node:child_process';

export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** { commit } for a clean git checkout of `dir`, otherwise { commit: undefined, reason }. */
export function generatorCommit(dir) {
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit;
  try {
    commit = git(['rev-parse', 'HEAD']);
  } catch {
    return { commit: undefined, reason: 'it is not a git checkout' };
  }
  if (!COMMIT_PATTERN.test(commit)) return { commit: undefined, reason: 'HEAD is not a commit' };
  try {
    if (git(['status', '--porcelain', '--', '.']) !== '') return { commit: undefined, reason: 'it has uncommitted changes' };
  } catch {
    return { commit: undefined, reason: 'its state could not be read' };
  }
  return { commit };
}
