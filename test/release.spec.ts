import { describe, expect, it } from 'vitest';
import { releaseBump, bumpVersion } from '../scripts/release';

describe('Conventional Commit releases', () => {
  it('uses the highest change severity and ignores maintenance commits', () => {
    expect(releaseBump(['docs: explain setup', 'chore(release): v0.1.0'])).toBeNull();
    expect(releaseBump(['fix(mail): retry delivery', 'perf: reduce payload'])).toBe('patch');
    expect(releaseBump(['feat(profile): add avatars', 'fix: handle empty input'])).toBe('minor');
    expect(releaseBump(['feat: profile support', 'fix!: change authentication'])).toBe('major');
    expect(releaseBump(['refactor(api): change payload\n\nBREAKING CHANGE: remove old field'])).toBe('major');
    expect(releaseBump(['Initial commit', 'feat without colon'])).toBeNull();
  });
  it('bumps versions and resets lower components', () => {
    expect(bumpVersion('0.0.0', 'minor')).toBe('0.1.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(() => bumpVersion('1.2.3-beta', 'patch')).toThrow();
  });
});
