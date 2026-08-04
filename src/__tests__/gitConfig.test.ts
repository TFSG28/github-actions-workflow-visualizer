import { describe, it, expect } from 'vitest';
import { parseOwnerRepoFromUrl, parseGithubRepoFromGitConfig } from '../gitConfig';

describe('parseOwnerRepoFromUrl', () => {
  it('parses https url', () => {
    expect(parseOwnerRepoFromUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses https url without .git', () => {
    expect(parseOwnerRepoFromUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses trailing slash', () => {
    expect(parseOwnerRepoFromUrl('https://github.com/owner/repo/')).toBe('owner/repo');
  });

  it('parses scp-style ssh', () => {
    expect(parseOwnerRepoFromUrl('git@github.com:Org/My-Repo.git')).toBe('Org/My-Repo');
  });

  it('parses ssh:// url', () => {
    expect(parseOwnerRepoFromUrl('ssh://git@github.com/Org/My-Repo.git')).toBe('Org/My-Repo');
  });

  it('rejects non-github hosts', () => {
    expect(parseOwnerRepoFromUrl('https://gitlab.com/o/r.git')).toBeNull();
  });
});

describe('parseGithubRepoFromGitConfig', () => {
  it('finds origin remote', () => {
    const config = '[remote "origin"]\n\turl = git@github.com:acme/api.git\n\tfetch = +refs\n';
    expect(parseGithubRepoFromGitConfig(config)).toBe('acme/api');
  });

  it('falls back to any github remote', () => {
    const config = '[remote "upstream"]\n\turl = https://github.com/acme/web\n';
    expect(parseGithubRepoFromGitConfig(config)).toBe('acme/web');
  });

  it('returns null for no github remote', () => {
    const config = '[remote "origin"]\n\turl = https://example.com/x/y.git\n';
    expect(parseGithubRepoFromGitConfig(config)).toBeNull();
  });
});
