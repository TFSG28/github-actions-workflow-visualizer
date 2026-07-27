// Regression check for git-remote -> owner/repo detection.
// Bundles the pure TS helper with esbuild (already a dependency) and asserts
// the URL/config forms that auto-detection relies on. Run: node scripts/check-detect.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const outUrl = new URL('../.detect-check.mjs', import.meta.url);
const outfile = fileURLToPath(outUrl);

await build({
  entryPoints: [fileURLToPath(new URL('../src/gitConfig.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
});

try {
  const { parseOwnerRepoFromUrl, parseGithubRepoFromGitConfig } = await import(outUrl.href);

  const url = {
    https: parseOwnerRepoFromUrl('https://github.com/owner/repo.git'),
    noGit: parseOwnerRepoFromUrl('https://github.com/owner/repo'),
    trailingSlash: parseOwnerRepoFromUrl('https://github.com/owner/repo/'),
    ssh: parseOwnerRepoFromUrl('git@github.com:Org/My-Repo.git'),
    sshProto: parseOwnerRepoFromUrl('ssh://git@github.com/Org/My-Repo.git'),
    notGithub: parseOwnerRepoFromUrl('https://gitlab.com/o/r.git')
  };
  assert.equal(url.https, 'owner/repo', 'https .git');
  assert.equal(url.noGit, 'owner/repo', 'https no .git');
  assert.equal(url.trailingSlash, 'owner/repo', 'trailing slash');
  assert.equal(url.ssh, 'Org/My-Repo', 'scp-style ssh');
  assert.equal(url.sshProto, 'Org/My-Repo', 'ssh:// url');
  assert.equal(url.notGithub, null, 'non-github host rejected');

  const originConfig = '[remote "origin"]\n\turl = git@github.com:acme/api.git\n\tfetch = +refs\n';
  assert.equal(parseGithubRepoFromGitConfig(originConfig), 'acme/api', 'origin remote');

  const upstreamOnly = '[remote "upstream"]\n\turl = https://github.com/acme/web\n';
  assert.equal(parseGithubRepoFromGitConfig(upstreamOnly), 'acme/web', 'falls back to any github remote');

  const noGithub = '[remote "origin"]\n\turl = https://example.com/x/y.git\n';
  assert.equal(parseGithubRepoFromGitConfig(noGithub), null, 'no github remote -> null');

  console.log('detect check: OK');
} finally {
  rmSync(outfile, { force: true });
}
