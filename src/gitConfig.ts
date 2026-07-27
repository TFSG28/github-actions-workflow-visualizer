// Pure parsing helpers for turning a repo's git config into an owner/repo slug.
// Kept free of any vscode/fs imports so they can be unit-checked in isolation
// (see scripts/check-detect.mjs).

export function parseOwnerRepoFromUrl(url: string): string | null {
  // Handles https/ssh/git forms, an optional .git suffix, and a trailing slash:
  //   https://github.com/owner/repo(.git)(/), git@github.com:owner/repo.git, ssh://git@github.com/owner/repo.git
  const match = url.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

export function parseGithubRepoFromGitConfig(contents: string): string | null {
  // Look for a remote "origin" URL first, then fall back to any github.com remote.
  const remoteBlocks = contents.split(/\[remote /).slice(1);
  const urls: { name: string; url: string }[] = [];

  for (const block of remoteBlocks) {
    const nameMatch = block.match(/^"([^"]+)"\]/);
    const urlMatch = block.match(/url\s*=\s*(.+)/);
    if (nameMatch && urlMatch) {
      urls.push({ name: nameMatch[1], url: urlMatch[1].trim() });
    }
  }

  const preferred = urls.find((r) => r.name === 'origin') || urls.find((r) => r.url.includes('github.com'));
  if (!preferred) {
    return null;
  }

  return parseOwnerRepoFromUrl(preferred.url);
}
