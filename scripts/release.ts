import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export type Bump = 'major' | 'minor' | 'patch' | null;
export function releaseBump(commits: string[]): Bump {
  let result: Bump = null;
  for (const commit of commits) {
    const subject = commit.split('\n')[0];
    const match = /^(\w+)(?:\([^\r\n)]+\))?(!)?: .+/.exec(subject);
    if (!match) continue;
    if (match[2] || /^BREAKING[ -]CHANGE:\s*\S/m.test(commit)) return 'major';
    if (match[1] === 'feat') result = 'minor';
    else if (['fix', 'perf', 'revert'].includes(match[1]) && !result) result = 'patch';
  }
  return result;
}
export function bumpVersion(version: string, bump: Exclude<Bump, null>): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable semantic version');
  const [major, minor, patch] = version.split('.').map(Number);
  return bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}
function git(...args: string[]) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function output(tag: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  console.log(tag ? `Release: ${tag}` : 'No release required.');
}
export function release() {
  if (!process.env.GITHUB_ACTIONS) throw new Error('Run releases through GitHub Actions.');
  git('fetch', 'origin', 'main', '--tags');
  const head = git('rev-parse', 'HEAD');
  if (head !== git('rev-parse', 'origin/main')) { output(''); return; }
  // Allow recovery after our version commit was pushed but release creation failed.
  if (process.env.GITHUB_SHA && head !== process.env.GITHUB_SHA) {
    if (git('rev-parse', 'HEAD^') !== process.env.GITHUB_SHA || !/^chore\(release\): v\d+\.\d+\.\d+$/.test(git('log', '-1', '--format=%s'))) { output(''); return; }
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-version:refname').split('\n');
  const previous = tags.find(tag => /^v\d+\.\d+\.\d+$/.test(tag));
  if (previous && git('rev-list', '-n', '1', previous) === head && previous === `v${pkg.version}`) { output(previous); return; }
  const commits = git('log', '--format=%B%x1e', ...(previous ? [`${previous}..HEAD`] : ['HEAD'])).split('\x1e').map(s => s.trim()).filter(Boolean);
  const bump = releaseBump(commits);
  if (!bump) { output(''); return; }
  if (previous && pkg.version !== previous.slice(1)) throw new Error('package.json and latest release tag disagree');
  pkg.version = bumpVersion(pkg.version, bump);
  const tag = `v${pkg.version}`;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', 'package.json');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', `chore(release): ${tag}`);
  git('-c', 'tag.gpgsign=false', 'tag', tag);
  git('push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${tag}`);
  output(tag);
}
if (import.meta.main) release();
