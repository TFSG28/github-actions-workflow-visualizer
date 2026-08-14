import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRun, RunJob, Annotation, WorkflowListItem } from './types';
import { TOKEN_SECRET_KEY, iconForState } from './utils';
import { parseGithubRepoFromGitConfig } from './gitConfig';
import { parseJobDependencies } from './deps';

// ---------------------------------------------------------------------------
// Debug output channel (shared across the extension)
// ---------------------------------------------------------------------------
let _outputChannel: vscode.OutputChannel | null = null;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('GHA Runs Viewer');
  }
  return _outputChannel;
}

function log(msg: string): void {
  const ch = getOutputChannel();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  ch.appendLine(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

export class RunItem extends vscode.TreeItem {
  constructor(public readonly run: WorkflowRun) {
    super(`#${run.run_number} ${run.display_title || run.name}`, vscode.TreeItemCollapsibleState.None);
    this.id = `run:${run.repo ?? ''}:${run.id}`;

    const state = run.status === 'completed' ? run.conclusion || 'unknown' : run.status;
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

export class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
  }
}

export class RepoItem extends vscode.TreeItem {
  constructor(public readonly repo: string, count: number) {
    super(repo, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `repo:${repo}`;
    this.description = count === 1 ? '1 run' : `${count} runs`;
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'ghaRepo';
  }
}

// ---------------------------------------------------------------------------
// Git-config repo detection
// ---------------------------------------------------------------------------

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
      const direct = path.join(gitDir, 'config');
      if (fs.existsSync(direct)) {
        return direct;
      }
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

function detectReposFromGitConfig(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const repos: string[] = [];
  const seen = new Set<string>();

  const tryDetect = (dirPath: string) => {
    const cfg = resolveGitConfigPath(dirPath);
    if (!cfg) {
      return;
    }
    try {
      const contents = fs.readFileSync(cfg, 'utf8');
      const match = parseGithubRepoFromGitConfig(contents);
      if (match) {
        const key = match.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          repos.push(match);
        }
      }
    } catch {
      // Ignore and continue.
    }
  };

  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'out', 'build', '.vscode', 'coverage', '__pycache__'
  ]);

  for (const folder of folders) {
    const rootPath = folder.uri.fsPath;
    tryDetect(rootPath);

    try {
      const entries = fs.readdirSync(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
          continue;
        }
        tryDetect(path.join(rootPath, entry.name));
      }
    } catch {
      // readdir failed — skip this folder.
    }
  }
  return repos;
}

// ---------------------------------------------------------------------------
// RunsProvider
// ---------------------------------------------------------------------------

/** GitHub's API returns max 30 jobs per page; paginate to collect all. */
async function fetchAllPages<T>(
  url: string,
  headers: Record<string, string>,
  etagMap: Map<string, string>,
  etagKey: string
): Promise<{ items: T[]; wasNotModified: boolean; error: string | null }> {
  let allItems: T[] = [];
  let pageUrl: string | null = url;
  const maxPages = 5;

  for (let page = 0; page < maxPages && pageUrl; page++) {
    const pageHeaders: Record<string, string> = { ...headers };
    const etag = etagMap.get(etagKey);
    if (etag && page === 0) {
      pageHeaders['If-None-Match'] = etag;
    }

    try {
      const resp = await fetch(pageUrl, { headers: pageHeaders });
      if (resp.status === 304) {
        return { items: [], wasNotModified: true, error: null };
      }
      if (!resp.ok) {
        return { items: allItems, wasNotModified: false, error: `${resp.status} ${resp.statusText}` };
      }

      // Store ETag from the first page
      if (page === 0) {
        const newEtag = resp.headers.get('etag');
        if (newEtag) {
          etagMap.set(etagKey, newEtag);
        } else {
          etagMap.delete(etagKey);
        }
      }

      const data = (await resp.json()) as { jobs?: T[] } & { workflow_runs?: T[] } & T[];
      const pageItems = (data.jobs || data.workflow_runs || (Array.isArray(data) ? data : [])) as T[];
      allItems = allItems.concat(pageItems);

      // Parse Link header for next page
      const linkHeader = resp.headers.get('link');
      pageUrl = null;
      if (linkHeader) {
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          pageUrl = nextMatch[1];
        }
      }
    } catch (err: any) {
      return { items: allItems, wasNotModified: false, error: err?.message || String(err) };
    }
  }

  return { items: allItems, wasNotModified: false, error: null };
}

export class RunsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private runs: WorkflowRun[] = [];
  private runsByRepo = new Map<string, WorkflowRun[]>();
  private resolvedRepos: string[] = [];
  private loading = false;
  private lastError: string | null = null;
  private etags = new Map<string, string>();
  /** ETag cache for jobs endpoint, keyed by runId */
  private jobEtags = new Map<string, string>();
  /** Cached jobs so 304 responses don't clear them. */
  private jobCache = new Map<number, RunJob[]>();
  private inFlight: Promise<void> | null = null;
  private statusFilter: string | null = null;
  private reposCache: string[] | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  resetCache(): void {
    this.etags.clear();
    this.jobEtags.clear();
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

    if (this.resolvedRepos.length > 1) {
      return this.resolvedRepos.map(
        (repo) => new RepoItem(repo, this.applyFilter(this.runsByRepo.get(repo) || []).length)
      );
    }

    if (this.runs.length === 0) {
      return [new MessageItem('No runs found.')];
    }
    const filtered = this.applyFilter(this.runs);
    if (filtered.length === 0) {
      return [new MessageItem('No runs match the current filter.')];
    }
    return filtered.map((r) => new RunItem(r));
  }

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

  repoOf(run: WorkflowRun): string | null {
    return run.repo ?? this.getResolvedRepos()[0] ?? null;
  }

  async loadRuns(): Promise<void> {
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
      this.lastError =
        'No GitHub repository detected. Run "GHA Runs: Set Repositories" to add one or more (owner/repo).';
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
      log(`Loading runs for ${repos.length} repo(s): ${repos.join(', ')}`);
      const errors = await Promise.all(repos.map((repo) => this.loadRepoRuns(repo, branch, headers)));

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

      const firstError = errors.find((e): e is string => !!e);
      this.lastError = merged.length === 0 && firstError ? firstError : null;

      if (firstError) {
        log(`Errors during load: ${errors.filter(Boolean).join('; ')}`);
      }
    } finally {
      this.loading = false;
    }
  }

  private async loadRepoRuns(
    repo: string,
    branch: string,
    baseHeaders: Record<string, string>
  ): Promise<string | null> {
    const [owner, repoName] = repo.split('/');
    let url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs?per_page=20`;
    if (branch) {
      url += `&branch=${encodeURIComponent(branch)}`;
    }

    const headers: Record<string, string> = { ...baseHeaders };
    const etag = this.etags.get(repo);
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    try {
      const response = await fetch(url, { headers });

      if (response.status === 304) {
        return null;
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
        return `GitHub API rate limit hit. Try again ${when}.`;
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
      log(`Loaded ${runs.length} runs for ${repo}`);
      return null;
    } catch (err: any) {
      return `Request failed for ${repo}: ${err?.message || String(err)}`;
    }
  }

  async authHeaders(): Promise<Record<string, string> | null> {
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
        vscode.window.showInformationMessage(
          `Rerun triggered for #${run.run_number} ${run.display_title || run.name}.`
        );
        setTimeout(() => this.refresh(), 2000);
      } else {
        const body = await response.text();
        vscode.window.showErrorMessage(
          `Failed to trigger rerun: ${response.status} ${response.statusText} ${body}`
        );
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
        vscode.window.showInformationMessage(
          `Rerun of failed jobs triggered for #${run.run_number} ${run.display_title || run.name}.`
        );
        setTimeout(() => this.refresh(), 2000);
      } else {
        const body = await response.text();
        vscode.window.showErrorMessage(
          `Failed to rerun failed jobs: ${response.status} ${response.statusText} ${body}`
        );
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
      if (response.status === 202) {
        vscode.window.showInformationMessage(
          `Cancellation requested for #${run.run_number} ${run.display_title || run.name}.`
        );
        setTimeout(() => this.refresh(), 2000);
      } else if (response.status === 409) {
        vscode.window.showWarningMessage(`Run #${run.run_number} is not in a cancellable state.`);
      } else {
        const body = await response.text();
        vscode.window.showErrorMessage(
          `Failed to cancel run: ${response.status} ${response.statusText} ${body}`
        );
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to cancel run: ${err?.message || String(err)}`);
    }
  }

  /**
   * Fetches jobs for a run with pagination support. Uses ETag caching so
   * repeated polls during an active run don't count against the rate limit.
   */
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
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${run.id}/jobs?per_page=100`;
    const etagKey = `jobs:${run.id}`;

    const { items, wasNotModified, error } = await fetchAllPages<RunJob>(url, headers, this.jobEtags, etagKey);
    if (wasNotModified) {
      // Keep the previously cached jobs on 304.
      return this.jobCache.get(run.id) || [];
    }
    if (error && items.length === 0) {
      log(`Failed to load jobs for run ${run.id}: ${error}`);
      vscode.window.showErrorMessage(`Failed to load run details: ${error}`);
      return this.jobCache.get(run.id) || null;
    }
    if (items.length === 0 && error) {
      log(`Partial jobs load for run ${run.id}: ${error}`);
    }
    if (items.length > 0) {
      this.jobCache.set(run.id, items);
    }
    return items;
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
      fresh.repo = repo;
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

  async fetchAllAnnotations(
    repo: string | undefined,
    jobs: RunJob[]
  ): Promise<Map<number, Annotation[]>> {
    const result = new Map<number, Annotation[]>();
    if (!repo) {
      return result;
    }
    const relevant = jobs.filter(
      (job) => !(job.status === 'completed' && job.conclusion === 'success')
    );
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
      const response = await fetch(url, {
        headers: { ...headers, Accept: 'application/vnd.github.raw' }
      });
      if (!response.ok) {
        return null;
      }
      const yamlText = await response.text();
      return parseJobDependencies(yamlText);
    } catch {
      return null;
    }
  }

  /** List workflows for a repo via the GitHub REST API. */
  async listWorkflows(repo: string): Promise<WorkflowListItem[] | null> {
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows?per_page=100`;
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        const body = await response.text();
        vscode.window.showErrorMessage(
          `Failed to list workflows: ${response.status} ${response.statusText} ${body}`
        );
        return null;
      }
      const data = (await response.json()) as { workflows?: WorkflowListItem[] };
      return data.workflows || [];
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to list workflows: ${err?.message || String(err)}`);
      return null;
    }
  }

  /** Read a workflow file's raw text from the repo's default branch. */
  async readWorkflowFile(repo: string, workflowPath: string): Promise<string | null> {
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${workflowPath}`;
    try {
      const response = await fetch(url, {
        headers: { ...headers, Accept: 'application/vnd.github.raw' }
      });
      if (!response.ok) {
        return null;
      }
      return await response.text();
    } catch {
      return null;
    }
  }

  /** Fetch the repo's branch names and default branch (for the ref picker). */
  async listBranches(
    repo: string
  ): Promise<{ branches: string[]; defaultBranch: string } | null> {
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }
    const [owner, repoName] = repo.split('/');
    const base = `https://api.github.com/repos/${owner}/${repoName}`;
    try {
      const [repoResp, branchesResp] = await Promise.all([
        fetch(base, { headers }),
        fetch(`${base}/branches?per_page=100`, { headers })
      ]);

      let defaultBranch = '';
      if (repoResp.ok) {
        const info = (await repoResp.json()) as { default_branch?: string };
        defaultBranch = info.default_branch || '';
      }

      const branches: string[] = [];
      if (branchesResp.ok) {
        const data = (await branchesResp.json()) as { name: string }[];
        branches.push(...data.map((b) => b.name));
      }
      return { branches, defaultBranch };
    } catch {
      return null;
    }
  }

  /**
   * List configured deployment environments. Returns null when the token lacks
   * the required scope, so callers can fall back to a plain input.
   */
  async listEnvironments(repo: string): Promise<string[] | null> {
    const headers = await this.authHeaders();
    if (!headers) {
      return null;
    }
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/environments?per_page=100`;
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as { environments?: { name: string }[] };
      return (data.environments || []).map((e) => e.name);
    } catch {
      return null;
    }
  }

  /**
   * Dispatch a workflow (trigger a new run). Requires a workflow file name or ID
   * and an optional ref (branch/tag) and inputs object.
   */
  async dispatchWorkflow(
    repo: string,
    workflowId: string,
    ref: string,
    inputs: Record<string, string> | null,
    label?: string
  ): Promise<void> {
    const headers = await this.authHeaders();
    if (!headers) {
      return;
    }
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;

    try {
      const body: Record<string, any> = { ref };
      if (inputs && Object.keys(inputs).length > 0) {
        body.inputs = inputs;
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (response.status === 204) {
        vscode.window.showInformationMessage(
          `Workflow dispatch triggered for ${label || workflowId} on ${ref}.`
        );
        setTimeout(() => this.refresh(), 2000);
      } else {
        const respBody = await response.text();
        vscode.window.showErrorMessage(
          `Failed to dispatch workflow: ${response.status} ${response.statusText} ${respBody}`
        );
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to dispatch workflow: ${err?.message || String(err)}`);
    }
  }
}
