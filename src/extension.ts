import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseGithubRepoFromGitConfig } from './gitConfig';

const TOKEN_SECRET_KEY = 'ghaRunsViewer.githubToken';

interface RunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: RunStep[];
}

interface RunStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  message: string;
  title: string | null;
}

interface WorkflowRun {
  id: number;
  name: string;
  display_title: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_number: number;
  run_attempt?: number;
  created_at: string;
  updated_at?: string;
  event: string;
  path: string;
  actor?: { login: string };
  /** owner/repo this run was fetched from; set by the provider at load time. */
  repo?: string;
}

function parseJobDependencies(yamlText: string): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  const lines = yamlText.split('\n');

  // Find the indentation level of "jobs:" and then the indentation of direct job-id children.
  let jobsIndent = -1;
  let jobIndent = -1;
  let currentJob: string | null = null;
  let inNeedsBlock = false;

  const indentOf = (line: string) => line.length - line.trimStart().length;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) {
      continue;
    }
    const indent = indentOf(raw);
    const trimmed = raw.trim();

    if (jobsIndent === -1) {
      if (/^jobs:\s*$/.test(trimmed)) {
        jobsIndent = indent;
      }
      continue;
    }

    // A line back at or above the "jobs:" indentation means we've left the jobs block.
    if (indent <= jobsIndent) {
      break;
    }

    // Detect a new job id: first child level under "jobs:".
    if (jobIndent === -1 || indent === jobIndent) {
      const jobMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (jobMatch && indent > jobsIndent) {
        jobIndent = indent;
        currentJob = jobMatch[1];
        deps.set(currentJob, []);
        inNeedsBlock = false;
        continue;
      }
    }

    if (!currentJob) {
      continue;
    }

    // Inline needs: needs: job1  OR  needs: [job1, job2]
    const inlineNeeds = trimmed.match(/^needs:\s*\[(.*)\]\s*$/);
    if (inlineNeeds) {
      const items = inlineNeeds[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      deps.set(currentJob, items);
      inNeedsBlock = false;
      continue;
    }
    const scalarNeeds = trimmed.match(/^needs:\s*([A-Za-z0-9_-]+)\s*$/);
    if (scalarNeeds) {
      deps.set(currentJob, [scalarNeeds[1]]);
      inNeedsBlock = false;
      continue;
    }
    if (/^needs:\s*$/.test(trimmed)) {
      inNeedsBlock = true;
      continue;
    }
    if (inNeedsBlock) {
      const listItem = trimmed.match(/^-\s*([A-Za-z0-9_-]+)\s*$/);
      if (listItem) {
        deps.get(currentJob)!.push(listItem[1]);
        continue;
      }
      inNeedsBlock = false;
    }
  }

  return deps;
}

class RunItem extends vscode.TreeItem {
  constructor(public readonly run: WorkflowRun) {
    super(`#${run.run_number} ${run.display_title || run.name}`, vscode.TreeItemCollapsibleState.None);
    // Stable id keeps VS Code from re-rendering/flickering the row on each poll.
    this.id = `run:${run.repo ?? ''}:${run.id}`;

    const state = run.status === 'completed' ? (run.conclusion || 'unknown') : run.status;
    this.description = `${run.head_branch}  ${state}`;
    this.tooltip = `${run.name}${run.repo ? `\nRepository: ${run.repo}` : ''}\nBranch: ${run.head_branch}\nEvent: ${run.event}\nStatus: ${state}\nCreated: ${run.created_at}`;
    this.iconPath = iconForState(run.status, run.conclusion);
    this.command = {
      command: 'ghaRunsViewer.viewRunDetails',
      title: 'View Run Details',
      arguments: [this]
    };
    this.contextValue = run.status === 'completed' ? 'ghaRun' : 'ghaRunRunning';
  }
}

function detectReposFromGitConfig(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const repos: string[] = [];
  for (const folder of folders) {
    const gitConfigPath = resolveGitConfigPath(folder.uri.fsPath);
    if (!gitConfigPath) {
      continue;
    }
    try {
      const contents = fs.readFileSync(gitConfigPath, 'utf8');
      const match = parseGithubRepoFromGitConfig(contents);
      if (match) {
        repos.push(match);
      }
    } catch {
      // Ignore and try the next folder.
    }
  }
  return repos;
}

/**
 * Resolve the path to a folder's git `config`, handling the normal `.git/`
 * directory as well as the `.git` *file* used by submodules and worktrees
 * (which contains a `gitdir:` pointer).
 */
function resolveGitConfigPath(folderPath: string): string | null {
  const gitPath = path.join(folderPath, '.git');
  try {
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return path.join(gitPath, 'config');
    }
    if (stat.isFile()) {
      const pointer = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
      if (!pointer) {
        return null;
      }
      let gitDir = pointer[1].trim();
      if (!path.isAbsolute(gitDir)) {
        gitDir = path.resolve(folderPath, gitDir);
      }
      // A plain submodule keeps its config here.
      const direct = path.join(gitDir, 'config');
      if (fs.existsSync(direct)) {
        return direct;
      }
      // A worktree points at a per-worktree dir; the shared config lives in commondir.
      const commonDirFile = path.join(gitDir, 'commondir');
      if (fs.existsSync(commonDirFile)) {
        let common = fs.readFileSync(commonDirFile, 'utf8').trim();
        if (!path.isAbsolute(common)) {
          common = path.resolve(gitDir, common);
        }
        const commonConfig = path.join(common, 'config');
        if (fs.existsSync(commonConfig)) {
          return commonConfig;
        }
      }
    }
  } catch {
    // Not a git folder, or unreadable.
  }
  return null;
}

function iconForState(status: string, conclusion: string | null): vscode.ThemeIcon {
  if (status !== 'completed') {
    return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
  }
  switch (conclusion) {
    case 'success':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'failure':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
    default:
      return new vscode.ThemeIcon('question');
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
  }
}

class RepoItem extends vscode.TreeItem {
  constructor(public readonly repo: string, count: number) {
    super(repo, vscode.TreeItemCollapsibleState.Expanded);
    // Stable id preserves the expand/collapse state across refreshes.
    this.id = `repo:${repo}`;
    this.description = count === 1 ? '1 run' : `${count} runs`;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'ghaRepo';
  }
}

class RunsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private runs: WorkflowRun[] = [];
  private runsByRepo = new Map<string, WorkflowRun[]>();
  private resolvedRepos: string[] = [];
  private loading = false;
  private lastError: string | null = null;
  private etags = new Map<string, string>();
  private inFlight: Promise<void> | null = null;
  private statusFilter: string | null = null;
  private reposCache: string[] | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Drop cached ETags and the resolved-repo list so the next refresh is fresh. */
  resetCache(): void {
    this.etags.clear();
    this.reposCache = null;
  }

  getFilter(): string | null {
    return this.statusFilter;
  }

  setFilter(filter: string | null): void {
    this.statusFilter = filter;
    this.refresh();
  }

  private applyFilter(runs: WorkflowRun[]): WorkflowRun[] {
    if (!this.statusFilter) {
      return runs;
    }
    if (this.statusFilter === 'in_progress') {
      return runs.filter((r) => r.status !== 'completed');
    }
    return runs.filter((r) => r.status === 'completed' && r.conclusion === this.statusFilter);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Second level: the runs belonging to a repository node.
    if (element instanceof RepoItem) {
      const runs = this.applyFilter(this.runsByRepo.get(element.repo) || []);
      if (runs.length === 0) {
        return [new MessageItem(this.statusFilter ? 'No matching runs.' : 'No runs.')];
      }
      return runs.map((r) => new RunItem(r));
    }

    await this.loadRuns();

    if (this.lastError) {
      return [new MessageItem(this.lastError)];
    }
    if (this.loading) {
      return [new MessageItem('Loading runs...')];
    }

    // More than one repository: show a repo node per repository.
    if (this.resolvedRepos.length > 1) {
      return this.resolvedRepos.map(
        (repo) => new RepoItem(repo, this.applyFilter(this.runsByRepo.get(repo) || []).length)
      );
    }

    // Single repository: keep the flat run list.
    if (this.runs.length === 0) {
      return [new MessageItem('No runs found.')];
    }
    const filtered = this.applyFilter(this.runs);
    if (filtered.length === 0) {
      return [new MessageItem('No runs match the current filter.')];
    }
    return filtered.map((r) => new RunItem(r));
  }

  /**
   * All repositories to query: configured list + legacy single + auto-detected,
   * deduped. Cached because auto-detection reads .git/config from disk; the cache
   * is cleared on config or workspace-folder changes via resetCache().
   */
  getResolvedRepos(): string[] {
    if (this.reposCache) {
      return this.reposCache;
    }
    const config = vscode.workspace.getConfiguration('ghaRunsViewer');
    const list = config.get<string[]>('repositories', []) || [];
    const single = config.get<string>('repository', '').trim();
    const configured = [...list, single].map((r) => (r || '').trim()).filter((r) => r.includes('/'));
    const all = [...configured, ...detectReposFromGitConfig()];

    const seen = new Set<string>();
    const result: string[] = [];
    for (const r of all) {
      const key = r.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(r);
      }
    }
    this.reposCache = result;
    return result;
  }

  private repoOf(run: WorkflowRun): string | null {
    return run.repo ?? this.getResolvedRepos()[0] ?? null;
  }

  async loadRuns(): Promise<void> {
    // Coalesce concurrent callers (e.g. the poll timer firing while a manual
    // refresh is already in progress) into a single in-flight request.
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.loadRunsInternal().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async loadRunsInternal(): Promise<void> {
    const config = vscode.workspace.getConfiguration('ghaRunsViewer');
    const branch = config.get<string>('branch', '').trim();
    const repos = this.getResolvedRepos();
    this.resolvedRepos = repos;

    if (repos.length === 0) {
      this.lastError = 'No GitHub repository detected. Run "GHA Runs: Set Repositories" to add one or more (owner/repo).';
      this.runs = [];
      this.runsByRepo.clear();
      this.etags.clear();
      return;
    }

    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
      this.lastError = 'No GitHub token set. Run "GHA Runs: Set GitHub Token".';
      this.runs = [];
      this.runsByRepo.clear();
      this.etags.clear();
      return;
    }

    this.loading = true;
    this.lastError = null;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gha-runs-viewer-extension'
    };

    try {
      const errors = await Promise.all(repos.map((repo) => this.loadRepoRuns(repo, branch, headers)));

      // Forget repositories that are no longer resolved.
      for (const key of Array.from(this.runsByRepo.keys())) {
        if (!repos.includes(key)) {
          this.runsByRepo.delete(key);
          this.etags.delete(key);
        }
      }

      const merged: WorkflowRun[] = [];
      for (const repo of repos) {
        merged.push(...(this.runsByRepo.get(repo) || []));
      }
      merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      this.runs = merged;

      // Only surface an error when there is nothing to show; a partial failure
      // (one bad repo) should not hide runs from the healthy repositories.
      const firstError = errors.find((e): e is string => !!e);
      this.lastError = merged.length === 0 && firstError ? firstError : null;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Fetch one repository's runs into the per-repo cache. Returns an error
   * string on failure, or null on success / 304-not-modified.
   */
  private async loadRepoRuns(repo: string, branch: string, baseHeaders: Record<string, string>): Promise<string | null> {
    const [owner, repoName] = repo.split('/');
    let url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs?per_page=20`;
    if (branch) {
      url += `&branch=${encodeURIComponent(branch)}`;
    }

    const headers: Record<string, string> = { ...baseHeaders };
    // A conditional request with a matching ETag returns 304 and does not count
    // against the rate limit, which matters given the default 30s poll interval.
    const etag = this.etags.get(repo);
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const response = await fetch(url, { headers });

      if (response.status === 304) {
        return null; // Not modified: keep the cached runs for this repo.
      }
      if (response.status === 401) {
        this.runsByRepo.set(repo, []);
        this.etags.delete(repo);
        return 'GitHub token is invalid or expired. Run "GHA Runs: Set GitHub Token" to update it.';
      }
      if (response.status === 404) {
        this.runsByRepo.set(repo, []);
        this.etags.delete(repo);
        return `Repository ${repo} not found or token lacks access.`;
      }
      if (response.status === 403 || response.status === 429) {
        const resetHeader = response.headers.get('x-ratelimit-reset');
        const retryAfter = response.headers.get('retry-after');
        let when = 'shortly';
        if (retryAfter) {
          when = `in ${retryAfter}s`;
        } else if (resetHeader) {
          const resetMs = Number(resetHeader) * 1000;
          if (!Number.isNaN(resetMs)) {
            const secs = Math.max(0, Math.round((resetMs - Date.now()) / 1000));
            when = `in ~${secs}s`;
          }
        }
        return `GitHub API rate limit hit. Try again ${when}.`; // keep cached runs
      }
      if (!response.ok) {
        this.runsByRepo.set(repo, []);
        this.etags.delete(repo);
        return `GitHub API error for ${repo}: ${response.status} ${response.statusText}`;
      }

      const newEtag = response.headers.get('etag');
      if (newEtag) {
        this.etags.set(repo, newEtag);
      } else {
        this.etags.delete(repo);
      }
      const data = (await response.json()) as { workflow_runs: WorkflowRun[] };
      const runs = (data.workflow_runs || []).map((r) => {
        r.repo = repo;
        return r;
      });
      this.runsByRepo.set(repo, runs);
      return null;
    } catch (err: any) {
      return `Request failed for ${repo}: ${err?.message || String(err)}`;
    }
  }

  private async authHeaders(): Promise<Record<string, string> | null> {
    const token = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
      vscode.window.showErrorMessage('No GitHub token set. Run "GHA Runs: Set GitHub Token" first.');
      return null;
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gha-runs-viewer-extension'
    };
  }

  async rerunRun(run: WorkflowRun): Promise<void> {
    const repo = this.repoOf(run);
    if (!repo) {
      vscode.window.showErrorMessage('No repository resolved. Run "GHA Runs: Set Repositories".');
      return;
    }
    const headers = await this.authHeaders();
    if (!headers) {
      return;
    }

    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run.id}/rerun`;

    try {
      const response = await fetch(url, { method: 'POST', headers });
      if (response.status === 201) {
        vscode.window.showInformationMessage(`Rerun triggered for #${run.run_number} ${run.display_title || run.name}.`);
        setTimeout(() => this.refresh(), 2000);
      } else {
        const body = await response.text();
        vscode.window.showErrorMessage(`Failed to trigger rerun: ${response.status} ${response.statusText} ${body}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to trigger rerun: ${err?.message || String(err)}`);
    }
  }

  async rerunFailedJobs(run: WorkflowRun): Promise<void> {
    const repo = this.repoOf(run);
    if (!repo) {
      vscode.window.showErrorMessage('No repository resolved. Run "GHA Runs: Set Repositories".');
      return;
    }
    const headers = await this.authHeaders();
    if (!headers) {
      return;
    }

    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run.id}/rerun-failed-jobs`;

    try {
      const response = await fetch(url, { method: 'POST', headers });
      if (response.status === 201) {
        vscode.window.showInformationMessage(`Rerun of failed jobs triggered for #${run.run_number} ${run.display_title || run.name}.`);
        setTimeout(() => this.refresh(), 2000);
      } else {
        const body = await response.text();
        vscode.window.showErrorMessage(`Failed to rerun failed jobs: ${response.status} ${response.statusText} ${body}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to rerun failed jobs: ${err?.message || String(err)}`);
    }
  }

  async cancelRun(run: WorkflowRun): Promise<void> {
    const repo = this.repoOf(run);
    if (!repo) {
      vscode.window.showErrorMessage('No repository resolved. Run "GHA Runs: Set Repositories".');
      return;
    }
    const headers = await this.authHeaders();
    if (!headers) {
      return;
    }

    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run.id}/cancel`;

    try {
      const response = await fetch(url, { method: 'POST', headers });
      // GitHub returns 202 Accepted when the cancellation is queued.
      if (response.status === 202) {
        vscode.window.showInformationMessage(`Cancellation requested for #${run.run_number} ${run.display_title || run.name}.`);
        setTimeout(() => this.refresh(), 2000);
      } else if (response.status === 409) {
        vscode.window.showWarningMessage(`Run #${run.run_number} is not in a cancellable state.`);
      } else {
        const body = await response.text();
        vscode.window.showErrorMessage(`Failed to cancel run: ${response.status} ${response.statusText} ${body}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to cancel run: ${err?.message || String(err)}`);
    }
  }

  async fetchRunJobs(run: WorkflowRun): Promise<RunJob[] | null> {
    const repo = this.repoOf(run);
    if (!repo) {
      return null;
    }
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }

    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run.id}/jobs`;

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        vscode.window.showErrorMessage(`Failed to load run details: ${response.status} ${response.statusText}`);
        return null;
      }
      const data = (await response.json()) as { jobs: RunJob[] };
      return data.jobs || [];
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to load run details: ${err?.message || String(err)}`);
      return null;
    }
  }

  async fetchSingleRun(run: WorkflowRun): Promise<WorkflowRun | null> {
    const repo = this.repoOf(run);
    if (!repo) {
      return null;
    }
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run.id}`;
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return null;
      }
      const fresh = (await response.json()) as WorkflowRun;
      fresh.repo = repo; // preserve the source repo across refreshes
      return fresh;
    } catch {
      return null;
    }
  }

  async fetchAnnotationsForJob(repo: string, jobId: number): Promise<Annotation[]> {
    const headers = await this.authHeaders();
    if (!headers) {
      return [];
    }
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/check-runs/${jobId}/annotations`;
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return [];
      }
      return (await response.json()) as Annotation[];
    } catch {
      return [];
    }
  }

  async fetchAllAnnotations(repo: string | undefined, jobs: RunJob[]): Promise<Map<number, Annotation[]>> {
    const result = new Map<number, Annotation[]>();
    if (!repo) {
      return result;
    }
    // ponytail: only query annotations for jobs that aren't a clean success.
    // Annotations are one HTTP request per job, so fetching them for every green
    // job is an N+1 storm on each poll. Ceiling: warnings/notices on an otherwise
    // successful job won't be shown until it fails.
    const relevant = jobs.filter((job) => !(job.status === 'completed' && job.conclusion === 'success'));
    await Promise.all(
      relevant.map(async (job) => {
        const annotations = await this.fetchAnnotationsForJob(repo, job.id);
        if (annotations.length > 0) {
          result.set(job.id, annotations);
        }
      })
    );
    return result;
  }

  async fetchWorkflowDependencies(run: WorkflowRun): Promise<Map<string, string[]> | null> {
    const repo = this.repoOf(run);
    if (!repo || !run.path) {
      return null;
    }
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }

    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${run.path}?ref=${encodeURIComponent(run.head_sha)}`;

    try {
      const response = await fetch(url, { headers: { ...headers, Accept: 'application/vnd.github.raw' } });
      if (!response.ok) {
        return null;
      }
      const yamlText = await response.text();
      return parseJobDependencies(yamlText);
    } catch {
      return null;
    }
  }
}

function stateLabel(status: string, conclusion: string | null): string {
  if (status !== 'completed') {
    return status;
  }
  return conclusion || 'unknown';
}

function computeLevels(jobs: RunJob[], deps: Map<string, string[]> | null): Map<string, number> {
  const levels = new Map<string, number>();
  const jobNames = jobs.map((j) => j.name);

  const resolveDepName = (depId: string): string | null => {
    // Try exact match first, then a prefix match for matrix job display names like "build (ubuntu-latest)".
    if (jobNames.includes(depId)) {
      return depId;
    }
    const prefixMatch = jobNames.find((n) => n === depId || n.startsWith(`${depId} (`));
    return prefixMatch || null;
  };

  const getDeps = (name: string): string[] => {
    if (!deps) {
      return [];
    }
    // deps map is keyed by yaml job id, which may differ from display name for matrix jobs.
    const direct = deps.get(name);
    if (direct) {
      return direct.map(resolveDepName).filter((n): n is string => !!n);
    }
    // Fall back: find a yaml key whose name matches this job's display name prefix.
    for (const [jobId, needs] of deps.entries()) {
      if (name === jobId || name.startsWith(`${jobId} (`)) {
        return needs.map(resolveDepName).filter((n): n is string => !!n);
      }
    }
    return [];
  };

  const visiting = new Set<string>();

  const levelOf = (name: string): number => {
    if (levels.has(name)) {
      return levels.get(name)!;
    }
    if (visiting.has(name)) {
      return 0; // Guard against cycles in malformed yaml.
    }
    visiting.add(name);
    const parents = getDeps(name);
    const level = parents.length === 0 ? 0 : Math.max(...parents.map(levelOf)) + 1;
    levels.set(name, level);
    visiting.delete(name);
    return level;
  };

  for (const job of jobs) {
    levelOf(job.name);
  }

  return levels;
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) {
    return '';
  }
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function annotationIcon(level: string): string {
  if (level === 'failure' || level === 'error') {
    return 'error';
  }
  if (level === 'warning') {
    return 'warning';
  }
  return 'notice';
}

interface RunModel {
  canvasWidth: number;
  canvasHeight: number;
  edgesSvg: string;
  nodesHtml: string;
  annotationsHtml: string;
  metaText: string;
  statusText: string;
  title: string;
  htmlUrl: string;
  isRunning: boolean;
  hasFailure: boolean;
}

function buildRunModel(
  run: WorkflowRun,
  jobs: RunJob[],
  deps: Map<string, string[]> | null,
  annotationsByJob: Map<number, Annotation[]>
): RunModel {
  const levels = computeLevels(jobs, deps);
  const byLevel = new Map<number, RunJob[]>();
  for (const job of jobs) {
    const lvl = levels.get(job.name) ?? 0;
    if (!byLevel.has(lvl)) {
      byLevel.set(lvl, []);
    }
    byLevel.get(lvl)!.push(job);
  }

  const NODE_WIDTH = 260;
  const COLUMN_GAP = 100;
  const ROW_GAP = 24;
  const HEADER_HEIGHT = 44;
  const STEP_ROW_HEIGHT = 28;
  const PADDING = 40;

  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  let maxLevel = 0;
  for (const lvl of byLevel.keys()) {
    maxLevel = Math.max(maxLevel, lvl);
  }

  for (const [lvl, jobsInLevel] of Array.from(byLevel.entries()).sort((a, b) => a[0] - b[0])) {
    let y = PADDING;
    for (const job of jobsInLevel) {
      const height = HEADER_HEIGHT + Math.max(job.steps.length, 1) * STEP_ROW_HEIGHT + 16;
      positions.set(job.name, { x: PADDING + lvl * (NODE_WIDTH + COLUMN_GAP), y, width: NODE_WIDTH, height });
      y += height + ROW_GAP;
    }
  }

  let canvasWidth = PADDING * 2 + (maxLevel + 1) * NODE_WIDTH + maxLevel * COLUMN_GAP;
  let canvasHeight = PADDING * 2;
  for (const jobsInLevel of byLevel.values()) {
    let colHeight = PADDING;
    for (const job of jobsInLevel) {
      const pos = positions.get(job.name)!;
      colHeight += pos.height + ROW_GAP;
    }
    canvasHeight = Math.max(canvasHeight, colHeight);
  }

  const jobNames = jobs.map((j) => j.name);
  const resolveDepName = (depId: string): string | null => {
    if (jobNames.includes(depId)) {
      return depId;
    }
    return jobNames.find((n) => n === depId || n.startsWith(`${depId} (`)) || null;
  };

  const edges: { from: string; to: string }[] = [];
  if (deps) {
    for (const job of jobs) {
      const direct = deps.get(job.name);
      const needsList = direct
        ? direct
        : Array.from(deps.entries()).find(([jobId]) => job.name === jobId || job.name.startsWith(`${jobId} (`))?.[1] || [];
      for (const needId of needsList) {
        const from = resolveDepName(needId);
        if (from && positions.has(from) && positions.has(job.name)) {
          edges.push({ from, to: job.name });
        }
      }
    }
  }

  const edgesSvg = edges
    .map(({ from, to }) => {
      const a = positions.get(from)!;
      const b = positions.get(to)!;
      const x1 = a.x + a.width;
      const y1 = a.y + a.height / 2;
      const x2 = b.x;
      const y2 = b.y + b.height / 2;
      const midX = (x1 + x2) / 2;
      return `<path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" class="edge" />`;
    })
    .join('');

  const nodesHtml = jobs
    .map((job, i) => {
      const pos = positions.get(job.name)!;
      const jobState = stateLabel(job.status, job.conclusion);
      const jobAnnotations = annotationsByJob.get(job.id) || [];
      const errorCount = jobAnnotations.filter((a) => a.annotation_level === 'failure').length;
      const warningCount = jobAnnotations.filter((a) => a.annotation_level === 'warning').length;
      const duration = formatDuration(job.started_at, job.completed_at);

      const stepsHtml = job.steps
        .map((step) => {
          const stepState = stateLabel(step.status, step.conclusion);
          const stepDuration = formatDuration(step.started_at, step.completed_at);
          return `<div class="step-row">
            <span class="node small ${stepState}"></span>
            <span class="step-name">${escapeHtml(step.name)}</span>
            <span class="step-duration">${stepDuration}</span>
          </div>`;
        })
        .join('');

      const badges = [];
      if (errorCount > 0) {
        badges.push(`<span class="count-badge error">${errorCount} error${errorCount > 1 ? 's' : ''}</span>`);
      }
      if (warningCount > 0) {
        badges.push(`<span class="count-badge warning">${warningCount} warning${warningCount > 1 ? 's' : ''}</span>`);
      }

      return `
        <div class="job-node ${jobState}" style="left:${pos.x}px; top:${pos.y}px; width:${pos.width}px; --i:${i};">
          <div class="job-header">
            <span class="node ${jobState}"></span>
            <span class="job-name">${escapeHtml(job.name)}</span>
            <span class="job-duration">${duration}</span>
          </div>
          ${badges.length ? `<div class="job-badges">${badges.join('')}</div>` : ''}
          <div class="job-body">
            ${stepsHtml || '<div class="no-steps">No steps reported.</div>'}
          </div>
        </div>`;
    })
    .join('');

  const annotationRows: string[] = [];
  for (const job of jobs) {
    const anns = annotationsByJob.get(job.id) || [];
    for (const ann of anns) {
      const icon = annotationIcon(ann.annotation_level);
      const location = ann.path && ann.path !== '.github' ? `${escapeHtml(ann.path)}:${ann.start_line}` : escapeHtml(job.name);
      annotationRows.push(`
        <div class="annotation-row ${icon}">
          <span class="node small ${icon === 'error' ? 'failure' : icon === 'warning' ? 'in_progress' : 'success'}"></span>
          <div class="annotation-text">
            <div class="annotation-title">${escapeHtml(ann.title || job.name)} <span class="annotation-location">${location}</span></div>
            <div class="annotation-message">${escapeHtml(ann.message)}</div>
          </div>
        </div>`);
    }
  }
  const annotationsHtml = annotationRows.length
    ? annotationRows.join('')
    : '<div class="no-annotations">No warnings or errors reported.</div>';

  const overallState = stateLabel(run.status, run.conclusion);
  const runDuration = formatDuration(run.created_at, run.status === 'completed' ? run.updated_at || null : null);
  const metaText = [
    `Branch: ${escapeHtml(run.head_branch)}`,
    `Event: ${escapeHtml(run.event)}`,
    run.actor?.login ? `Triggered by: ${escapeHtml(run.actor.login)}` : null,
    run.run_attempt && run.run_attempt > 1 ? `Attempt: ${run.run_attempt}` : null,
    runDuration ? `Duration: ${runDuration}` : null
  ]
    .filter(Boolean)
    .join(' &middot; ');

  return {
    canvasWidth,
    canvasHeight,
    edgesSvg,
    nodesHtml,
    annotationsHtml,
    metaText,
    statusText: overallState,
    title: `#${run.run_number} ${run.display_title || run.name}`,
    htmlUrl: run.html_url,
    isRunning: run.status !== 'completed',
    hasFailure: overallState === 'failure'
  };
}

interface LivePanelHandle {
  panel: vscode.WebviewPanel;
}

function showRunDetails(
  provider: RunsProvider,
  run: WorkflowRun,
  jobs: RunJob[],
  deps: Map<string, string[]> | null,
  annotationsByJob: Map<number, Annotation[]>
): void {
  const panel = vscode.window.createWebviewPanel(
    'ghaRunDetails',
    `Run #${run.run_number}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const model = buildRunModel(run, jobs, deps, annotationsByJob);
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  * {
    box-sizing: border-box;
  }
  html, body {
    height: 100%;
    margin: 0;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
  }
  .toolbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    padding: 14px 20px;
    background-color: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .toolbar-info { min-width: 0; }
  .title-row { display: flex; align-items: center; gap: 10px; }
  .title-row h1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title-row .status-pill { margin-left: 0; }
  .toolbar h1 {
    font-size: 1.1em;
    font-weight: 600;
    margin: 0;
    display: inline;
    letter-spacing: -0.01em;
  }
  .toolbar .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 10px;
    padding: 2px 10px 2px 8px;
    border-radius: 999px;
    font-size: 0.72em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    vertical-align: middle;
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .status-pill::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background-color: currentColor;
  }
  .status-pill.success { color: var(--vscode-testing-iconPassed); }
  .status-pill.failure { color: var(--vscode-testing-iconFailed); }
  .status-pill.cancelled { color: var(--vscode-descriptionForeground); }
  .status-pill.in_progress, .status-pill.queued { color: var(--vscode-testing-iconQueued); }
  .toolbar .meta {
    color: var(--vscode-descriptionForeground);
    font-size: 0.83em;
    margin-top: 6px;
  }
  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
  }
  .btn-group {
    display: flex;
    gap: 2px;
    background-color: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 3px;
  }
  .btn {
    background-color: transparent;
    color: var(--vscode-foreground);
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.85em;
    font-weight: 500;
    white-space: nowrap;
    transition: background-color 0.1s ease, color 0.1s ease;
  }
  .btn:hover {
    background-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .btn.icon { min-width: 26px; font-variant-numeric: tabular-nums; }
  #zoomLabel {
    min-width: 46px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
  }
  .btn-danger:hover {
    background-color: var(--vscode-inputValidation-errorBackground, var(--vscode-testing-iconFailed));
    color: var(--vscode-editor-background);
  }
  #legend {
    position: fixed;
    left: 16px;
    bottom: 14px;
    z-index: 9;
    display: flex;
    gap: 14px;
    padding: 7px 12px;
    border-radius: 8px;
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    background-color: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
    border: 1px solid var(--vscode-panel-border);
    backdrop-filter: blur(3px);
  }
  #legend span { display: inline-flex; align-items: center; gap: 6px; }
  #legend .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background-color: var(--vscode-descriptionForeground);
  }
  #legend .dot.success { background-color: var(--vscode-testing-iconPassed); }
  #legend .dot.failure { background-color: var(--vscode-testing-iconFailed); }
  #legend .dot.in_progress { background-color: var(--vscode-testing-iconQueued); }
  .empty-graph { padding: 24px; color: var(--vscode-descriptionForeground); }

  @keyframes nodeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: no-preference) {
    #stage.animate .job-node {
      animation: nodeIn 0.42s cubic-bezier(0.22, 1, 0.36, 1) backwards;
      animation-delay: calc(var(--i, 0) * 45ms);
    }
    #stage.animate #edgesSvg {
      animation: fadeIn 0.5s ease backwards;
      animation-delay: 0.15s;
    }
  }
  #viewport {
    position: absolute;
    top: 76px;
    left: 0;
    right: 320px;
    bottom: 0;
    overflow: hidden;
    cursor: grab;
    background-color: var(--vscode-editor-background);
  }
  #viewport.dragging {
    cursor: grabbing;
  }
  #stage {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
  }
  svg.edges {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
    pointer-events: none;
  }
  .edge {
    fill: none;
    stroke: var(--vscode-panel-border);
    stroke-width: 2;
  }
  .job-node {
    position: absolute;
    background-color: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.16), 0 1px 2px rgba(0, 0, 0, 0.1);
    transition: box-shadow 0.12s ease;
  }
  .job-node:hover {
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.22), 0 2px 4px rgba(0, 0, 0, 0.14);
  }
  .job-node.failure {
    border-color: var(--vscode-testing-iconFailed);
  }
  .job-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-weight: 600;
    font-size: 0.92em;
    border-radius: 8px 8px 0 0;
  }
  .job-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-duration {
    font-weight: 400;
    font-size: 0.83em;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }
  .job-badges {
    display: flex;
    gap: 6px;
    padding: 8px 12px 0 12px;
  }
  .count-badge {
    font-size: 0.72em;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--vscode-editor-background);
  }
  .count-badge.error { background-color: var(--vscode-testing-iconFailed); }
  .count-badge.warning { background-color: var(--vscode-testing-iconQueued); }
  .job-body {
    padding: 8px 12px 10px 12px;
  }
  .step-row {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 27px;
    font-size: 0.87em;
  }
  .step-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-duration {
    color: var(--vscode-descriptionForeground);
    font-size: 0.88em;
    font-variant-numeric: tabular-nums;
  }
  .node {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    flex: 0 0 auto;
    background-color: var(--vscode-descriptionForeground);
    box-shadow: 0 0 0 2px var(--vscode-editorWidget-background);
  }
  .node.small {
    width: 8px;
    height: 8px;
    box-shadow: none;
  }
  .node.success { background-color: var(--vscode-testing-iconPassed); }
  .node.failure { background-color: var(--vscode-testing-iconFailed); }
  .node.cancelled { background-color: var(--vscode-descriptionForeground); }
  .node.in_progress, .node.queued { background-color: var(--vscode-testing-iconQueued); }
  .no-steps {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #annotationsPanel {
    position: fixed;
    top: 76px;
    right: 0;
    bottom: 0;
    width: 320px;
    border-left: 1px solid var(--vscode-panel-border);
    background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
    overflow-y: auto;
    padding: 16px;
  }
  #annotationsPanel h2 {
    font-size: 0.78em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 12px 0;
  }
  .annotation-row {
    display: flex;
    gap: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 6px;
    background-color: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--vscode-descriptionForeground);
  }
  .annotation-row.error {
    border-left-color: var(--vscode-testing-iconFailed);
  }
  .annotation-row.warning {
    border-left-color: var(--vscode-testing-iconQueued);
  }
  .annotation-row .node {
    margin-top: 3px;
    box-shadow: none;
  }
  .annotation-text {
    flex: 1;
    min-width: 0;
  }
  .annotation-title {
    font-size: 0.86em;
    font-weight: 600;
  }
  .annotation-location {
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
  }
  .annotation-message {
    font-size: 0.83em;
    color: var(--vscode-descriptionForeground);
    white-space: pre-wrap;
    margin-top: 4px;
    line-height: 1.4;
  }
  .no-annotations {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-info">
      <div class="title-row">
        <h1 id="runTitle">${escapeHtml(model.title)}</h1>
        <span id="statusPill" class="status-pill ${model.statusText}">${model.statusText}</span>
      </div>
      <div id="metaText" class="meta">${model.metaText}</div>
    </div>
    <div class="toolbar-actions">
      <div class="btn-group">
        <button class="btn" id="btnOpen" title="Open this run on github.com">Open&nbsp;&#8599;</button>
        <button class="btn" id="btnRerun" title="Rerun all jobs">Rerun&nbsp;&#8635;</button>
        <button class="btn" id="btnRerunFailed" title="Rerun only the failed jobs">Rerun failed</button>
        <button class="btn btn-danger" id="btnCancel" title="Cancel this run">Cancel&nbsp;&#10005;</button>
      </div>
      <div class="btn-group">
        <button class="btn icon" id="zoomOut" title="Zoom out">&#8722;</button>
        <button class="btn" id="zoomLabel" title="Reset to 100%">100%</button>
        <button class="btn icon" id="zoomIn" title="Zoom in">+</button>
        <button class="btn" id="zoomFit" title="Fit graph to view (0)">Fit</button>
      </div>
    </div>
  </div>
  <div id="viewport" tabindex="0">
    <div id="stage" style="width:${model.canvasWidth}px; height:${model.canvasHeight}px;">
      <svg id="edgesSvg" class="edges" width="${model.canvasWidth}" height="${model.canvasHeight}">${model.edgesSvg}</svg>
      <div id="nodesContainer">${model.nodesHtml || '<p class="empty-graph">No jobs found for this run.</p>'}</div>
    </div>
  </div>
  <div id="legend">
    <span><i class="dot success"></i>Success</span>
    <span><i class="dot failure"></i>Failure</span>
    <span><i class="dot in_progress"></i>Running</span>
    <span><i class="dot"></i>Cancelled</span>
  </div>
  <div id="annotationsPanel">
    <h2>Annotations</h2>
    <div id="annotationsList">${model.annotationsHtml}</div>
  </div>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const viewport = document.getElementById('viewport');
    const stage = document.getElementById('stage');
    const nodesContainer = document.getElementById('nodesContainer');
    const zoomLabel = document.getElementById('zoomLabel');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const MIN = 0.3, MAX = 2.5;
    let canvasWidth = ${model.canvasWidth};
    let canvasHeight = ${model.canvasHeight};
    let scale = 1, originX = 0, originY = 0;
    let isDragging = false, lastX = 0, lastY = 0;

    function apply() {
      stage.style.transform = 'translate(' + originX + 'px, ' + originY + 'px) scale(' + scale + ')';
      zoomLabel.textContent = Math.round(scale * 100) + '%';
    }

    function fit() {
      const vw = viewport.clientWidth, vh = viewport.clientHeight;
      if (!canvasWidth || !canvasHeight) { return; }
      const s = Math.min(vw / canvasWidth, vh / canvasHeight) * 0.92;
      scale = Math.max(MIN, Math.min(MAX, s));
      originX = Math.max(0, (vw - canvasWidth * scale) / 2);
      originY = Math.max(0, (vh - canvasHeight * scale) / 2);
      apply();
    }

    function zoomBy(delta, cx, cy) {
      const prev = scale;
      scale = Math.max(MIN, Math.min(MAX, scale + delta));
      if (cx !== undefined) {
        // keep the point under the cursor anchored while zooming
        originX = cx - (cx - originX) * (scale / prev);
        originY = cy - (cy - originY) * (scale / prev);
      }
      apply();
    }

    viewport.addEventListener('mousedown', (e) => {
      isDragging = true; lastX = e.clientX; lastY = e.clientY;
      viewport.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      originX += e.clientX - lastX;
      originY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    });
    window.addEventListener('mouseup', () => {
      isDragging = false; viewport.classList.remove('dragging');
    });

    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomBy(e.deltaY > 0 ? -0.12 : 0.12, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    document.getElementById('zoomIn').addEventListener('click', () => zoomBy(0.15));
    document.getElementById('zoomOut').addEventListener('click', () => zoomBy(-0.15));
    document.getElementById('zoomFit').addEventListener('click', fit);
    zoomLabel.addEventListener('click', () => { scale = 1; apply(); });

    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '+' || e.key === '=') zoomBy(0.15);
      else if (e.key === '-' || e.key === '_') zoomBy(-0.15);
      else if (e.key === '0') fit();
    });

    function send(action) { vscodeApi.postMessage({ type: 'action', action: action }); }
    document.getElementById('btnOpen').addEventListener('click', () => send('open'));
    document.getElementById('btnRerun').addEventListener('click', () => send('rerun'));
    document.getElementById('btnRerunFailed').addEventListener('click', () => send('rerunFailed'));
    document.getElementById('btnCancel').addEventListener('click', () => send('cancel'));

    function updateActions(isRunning, hasFailure) {
      document.getElementById('btnRerun').style.display = isRunning ? 'none' : '';
      document.getElementById('btnRerunFailed').style.display = (!isRunning && hasFailure) ? '' : 'none';
      document.getElementById('btnCancel').style.display = isRunning ? '' : 'none';
    }

    function runEntrance() {
      if (reduceMotion) return;
      stage.classList.add('animate');
      setTimeout(() => stage.classList.remove('animate'), 1400);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'update') return;
      const model = msg.model;
      canvasWidth = model.canvasWidth;
      canvasHeight = model.canvasHeight;
      document.getElementById('runTitle').textContent = model.title;
      const pill = document.getElementById('statusPill');
      pill.textContent = model.statusText;
      pill.className = 'status-pill ' + model.statusText;
      document.getElementById('metaText').innerHTML = model.metaText;
      stage.style.width = canvasWidth + 'px';
      stage.style.height = canvasHeight + 'px';
      const svg = document.getElementById('edgesSvg');
      svg.setAttribute('width', canvasWidth);
      svg.setAttribute('height', canvasHeight);
      svg.innerHTML = model.edgesSvg;
      nodesContainer.innerHTML = model.nodesHtml || '<p class="empty-graph">No jobs found for this run.</p>';
      document.getElementById('annotationsList').innerHTML = model.annotationsHtml;
      updateActions(model.isRunning, model.hasFailure);
    });

    updateActions(${model.isRunning}, ${model.hasFailure});
    requestAnimationFrame(() => { fit(); runEntrance(); });
  </script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || msg.type !== 'action') {
      return;
    }
    switch (msg.action) {
      case 'open':
        vscode.env.openExternal(vscode.Uri.parse(run.html_url));
        break;
      case 'rerun':
        await provider.rerunRun(run);
        break;
      case 'rerunFailed':
        await provider.rerunFailedJobs(run);
        break;
      case 'cancel':
        await provider.cancelRun(run);
        break;
    }
  });

  let disposed = false;
  panel.onDidDispose(() => {
    disposed = true;
  });

  const poll = async () => {
    if (disposed) {
      return;
    }
    // Don't spend API calls while the panel is in a background tab; just
    // reschedule and pick up again when it's visible.
    if (!panel.visible) {
      setTimeout(poll, 8000);
      return;
    }
    const freshRun = (await provider.fetchSingleRun(run)) || run;
    const freshJobs = (await provider.fetchRunJobs(freshRun)) || jobs;
    const freshAnnotations = await provider.fetchAllAnnotations(freshRun.repo, freshJobs);
    if (disposed) {
      return;
    }
    const updatedModel = buildRunModel(freshRun, freshJobs, deps, freshAnnotations);
    panel.webview.postMessage({ type: 'update', model: updatedModel });

    run = freshRun;
    jobs = freshJobs;

    if (freshRun.status !== 'completed' && !disposed) {
      setTimeout(poll, 8000);
    }
  };

  if (run.status !== 'completed') {
    setTimeout(poll, 8000);
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new RunsProvider(context);
  const treeView = vscode.window.createTreeView('ghaRunsView', { treeDataProvider: provider });
  context.subscriptions.push(treeView);

  // Re-detect repositories when the set of workspace folders changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.resetCache();
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ghaRunsViewer.setToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter a GitHub Personal Access Token (needs "repo" and "workflow" or fine-grained Actions:read access)',
        password: true,
        ignoreFocusOut: true
      });
      if (token) {
        await context.secrets.store(TOKEN_SECRET_KEY, token.trim());
        provider.resetCache();
        vscode.window.showInformationMessage('GitHub token saved.');
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand('ghaRunsViewer.clearToken', async () => {
      await context.secrets.delete(TOKEN_SECRET_KEY);
      provider.resetCache();
      vscode.window.showInformationMessage('GitHub token cleared.');
      provider.refresh();
    }),

    vscode.commands.registerCommand('ghaRunsViewer.setRepo', async () => {
      const config = vscode.workspace.getConfiguration('ghaRunsViewer');
      const existing = config.get<string[]>('repositories', []) || [];
      const legacy = config.get<string>('repository', '').trim();
      const current = (existing.length ? existing : legacy ? [legacy] : []).join(', ');
      const input = await vscode.window.showInputBox({
        prompt: 'Repositories to track, in owner/repo format (comma-separated for multiple)',
        value: current,
        placeHolder: 'octocat/hello-world, myorg/api',
        ignoreFocusOut: true
      });
      if (input === undefined) {
        return;
      }
      const repos = input
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s.includes('/'));
      await config.update('repositories', repos, vscode.ConfigurationTarget.Global);
      // Migrate off the legacy single-repo setting so it isn't merged in twice.
      if (legacy) {
        await config.update('repository', '', vscode.ConfigurationTarget.Global);
      }
      provider.resetCache();
      provider.refresh();
    }),

    vscode.commands.registerCommand('ghaRunsViewer.refresh', () => {
      provider.refresh();
    }),

    vscode.commands.registerCommand('ghaRunsViewer.openRun', (arg: string | RunItem) => {
      const url = typeof arg === 'string' ? arg : arg?.run?.html_url;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),

    vscode.commands.registerCommand('ghaRunsViewer.copyRunUrl', async (item: RunItem) => {
      if (item?.run?.html_url) {
        await vscode.env.clipboard.writeText(item.run.html_url);
        vscode.window.showInformationMessage(`Copied run URL for #${item.run.run_number}.`);
      }
    }),

    vscode.commands.registerCommand('ghaRunsViewer.cancelRun', async (item: RunItem) => {
      if (!item?.run) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Cancel run #${item.run.run_number} ${item.run.display_title || item.run.name}?`,
        { modal: true },
        'Cancel Run'
      );
      if (confirm === 'Cancel Run') {
        await provider.cancelRun(item.run);
      }
    }),

    vscode.commands.registerCommand('ghaRunsViewer.filterStatus', async () => {
      const current = provider.getFilter();
      const picks = [
        { label: 'All runs', value: null },
        { label: 'Success', value: 'success' },
        { label: 'Failure', value: 'failure' },
        { label: 'In progress', value: 'in_progress' },
        { label: 'Cancelled', value: 'cancelled' }
      ];
      const choice = await vscode.window.showQuickPick(
        picks.map((p) => ({ label: (p.value === current ? '$(check) ' : '') + p.label, value: p.value })),
        { placeHolder: 'Filter workflow runs by status' }
      );
      if (choice !== undefined) {
        provider.setFilter(choice.value);
      }
    }),

    vscode.commands.registerCommand('ghaRunsViewer.rerunRun', async (item: RunItem) => {
      if (!item?.run) {
        return;
      }
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Rerun all jobs', value: 'all' },
          { label: 'Rerun failed jobs only', value: 'failed' }
        ],
        { placeHolder: `Rerun #${item.run.run_number} ${item.run.display_title || item.run.name}` }
      );
      if (!choice) {
        return;
      }
      if (choice.value === 'all') {
        await provider.rerunRun(item.run);
      } else {
        await provider.rerunFailedJobs(item.run);
      }
    }),

    vscode.commands.registerCommand('ghaRunsViewer.viewRunDetails', async (item: RunItem) => {
      if (!item?.run) {
        return;
      }
      const jobs = await provider.fetchRunJobs(item.run);
      if (jobs) {
        const [deps, annotations] = await Promise.all([
          provider.fetchWorkflowDependencies(item.run),
          provider.fetchAllAnnotations(item.run.repo, jobs)
        ]);
        showRunDetails(provider, item.run, jobs, deps, annotations);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // A manually edited repository/branch filter invalidates the ETag
      // cache, since a 304 would otherwise silently keep showing stale runs.
      if (
        e.affectsConfiguration('ghaRunsViewer.repository') ||
        e.affectsConfiguration('ghaRunsViewer.repositories') ||
        e.affectsConfiguration('ghaRunsViewer.branch')
      ) {
        provider.resetCache();
        provider.refresh();
      }
    })
  );

  const config = vscode.workspace.getConfiguration('ghaRunsViewer');
  const intervalSeconds = config.get<number>('pollIntervalSeconds', 30);
  if (intervalSeconds > 0) {
    // Only poll while the view is actually visible and the window is focused.
    // This avoids burning API calls (and rate limit) when the panel is hidden.
    const interval = setInterval(() => {
      if (treeView.visible && vscode.window.state.focused) {
        provider.refresh();
      }
    }, intervalSeconds * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });
  }

  // Refresh once when the view becomes visible again so stale data updates promptly.
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        provider.refresh();
      }
    })
  );

  provider.refresh();
}

export function deactivate() {}
