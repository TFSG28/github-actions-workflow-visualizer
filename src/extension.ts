import * as vscode from 'vscode';
import { RunsProvider, RunItem, getOutputChannel } from './provider';
import { showRunDetails, disposeActivePanel } from './webview';
import { TOKEN_SECRET_KEY } from './utils';
import { parseWorkflowDispatch } from './workflow';
import type { WorkflowDispatchInput } from './types';

/**
 * Prompt the user for a single `workflow_dispatch` input, using a QuickPick for
 * `choice`, `boolean`, and `environment` inputs and an InputBox for strings.
 */
async function promptForInput(
  input: WorkflowDispatchInput,
  provider: RunsProvider,
  repo: string
): Promise<string | undefined> {
  const title = `Input: ${input.name}${input.required ? ' (required)' : ''}`;
  const hint = input.description || input.name;
  const def = input.default != null ? String(input.default) : undefined;

  if (input.type === 'boolean') {
    const isTrue = input.default === true || input.default === 'true';
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'true', description: isTrue ? 'default' : undefined, picked: isTrue },
        { label: 'false', description: isTrue ? undefined : 'default', picked: !isTrue }
      ],
      { title, placeHolder: hint }
    );
    return pick?.label;
  }

  if (input.type === 'choice' && Array.isArray(input.options) && input.options.length > 0) {
    const pick = await vscode.window.showQuickPick(
      input.options.map((option) => ({
        label: option,
        description: option === def ? 'default' : undefined,
        picked: option === def
      })),
      { title, placeHolder: hint }
    );
    return pick?.label;
  }

  if (input.type === 'environment') {
    const environments = await provider.listEnvironments(repo);
    if (environments && environments.length > 0) {
      const pick = await vscode.window.showQuickPick(
        environments.map((name) => ({
          label: name,
          description: name === def ? 'default' : undefined,
          picked: name === def
        })),
        { title, placeHolder: hint }
      );
      return pick?.label;
    }
    // Environments can't be listed (missing scope or none configured): fall back
    // to a free-text input.
  }

  return vscode.window.showInputBox({
    title,
    prompt: hint,
    value: def ?? '',
    ignoreFocusOut: true,
    validateInput: input.required ? (v) => (v.trim() ? undefined : 'This input is required') : undefined
  });
}

export function activate(context: vscode.ExtensionContext) {
  const log = getOutputChannel();
  log.appendLine('GitHub Actions Workflow Visualizer activated.');

  const provider = new RunsProvider(context);
  const treeView = vscode.window.createTreeView('ghaRunsView', { treeDataProvider: provider });
  context.subscriptions.push(treeView);

  // Re-detect repositories when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.resetCache();
      provider.refresh();
    })
  );

  context.subscriptions.push(
    // ── Token management ──
    vscode.commands.registerCommand('ghaRunsViewer.setToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt:
          'Enter a GitHub Personal Access Token (needs "repo" and "workflow" or fine-grained Actions:read access)',
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

    // ── Repository setup ──
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
      if (legacy) {
        await config.update('repository', '', vscode.ConfigurationTarget.Global);
      }
      provider.resetCache();
      provider.refresh();
    }),

    // ── Refresh ──
    vscode.commands.registerCommand('ghaRunsViewer.refresh', () => {
      provider.refresh();
    }),

    // ── Open / Copy ──
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

    // ── Cancel ──
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

    // ── Filter ──
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

    // ── Rerun (sidebar context menu → quickpick all/failed) ──
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

    // ── View run details (opens the webview) ──
    vscode.commands.registerCommand('ghaRunsViewer.viewRunDetails', async (item: RunItem) => {
      if (!item?.run) {
        return;
      }
      const run = item.run;
      const repo = provider.repoOf(run);
      if (!repo) {
        vscode.window.showErrorMessage(
          'No repository resolved. Run "GHA Runs: Set Repositories".'
        );
        return;
      }

      const [jobs, deps] = await Promise.all([
        provider.fetchRunJobs(run),
        provider.fetchWorkflowDependencies(run)
      ]);

      if (!jobs) {
        return;
      }

      const annotationsByJob = await provider.fetchAllAnnotations(repo, jobs);
      showRunDetails(provider, run, jobs, deps, annotationsByJob);
    }),

    // ── Run workflow (guided dispatch, like the GitHub web UI) ──
    vscode.commands.registerCommand('ghaRunsViewer.dispatchWorkflow', async () => {
      const repos = provider.getResolvedRepos();
      if (repos.length === 0) {
        vscode.window.showErrorMessage(
          'No repository resolved. Run "GHA Runs: Set Repositories".'
        );
        return;
      }
      const repoSel = repos.length === 1 ? { label: repos[0] } : await vscode.window.showQuickPick(
        repos.map((r) => ({ label: r })),
        { placeHolder: 'Select repository to run a workflow on' }
      );
      if (!repoSel) {
        return;
      }
      const repo = repoSel.label;

      // 1. Pick a workflow.
      const workflows = await provider.listWorkflows(repo);
      if (workflows === null) {
        return;
      }
      const active = workflows.filter((w) => w.state === 'active');
      if (active.length === 0) {
        vscode.window.showErrorMessage(`No active workflows found in ${repo}.`);
        return;
      }
      const workflowSel = await vscode.window.showQuickPick(
        active.map((w) => ({ label: w.name, description: w.path, workflow: w })),
        { placeHolder: 'Select a workflow to run' }
      );
      if (!workflowSel) {
        return;
      }
      const workflow = workflowSel.workflow;

      // 2. Inspect the workflow file for a workflow_dispatch trigger and its inputs.
      const fileText = await provider.readWorkflowFile(repo, workflow.path);
      if (fileText === null) {
        vscode.window.showErrorMessage(`Could not read ${workflow.path} from ${repo}.`);
        return;
      }
      const { hasWorkflowDispatch, inputs } = parseWorkflowDispatch(fileText);
      if (!hasWorkflowDispatch) {
        vscode.window.showWarningMessage(
          `"${workflow.name}" has no workflow_dispatch trigger, so it cannot be run manually.`
        );
        return;
      }

      // 3. Pick the branch to run on.
      const branches = await provider.listBranches(repo);
      let ref: string | undefined;
      if (branches && branches.branches.length > 0) {
        const def = branches.defaultBranch || branches.branches[0];
        const pick = await vscode.window.showQuickPick(
          branches.branches.map((name) => ({
            label: name,
            description: name === def ? 'default' : undefined
          })),
          { placeHolder: 'Select the branch to run on' }
        );
        ref = pick?.label;
      } else {
        ref = await vscode.window.showInputBox({
          prompt: 'Git ref (branch or tag) to run on',
          value: branches?.defaultBranch || 'main',
          ignoreFocusOut: true
        });
      }
      if (!ref) {
        return;
      }

      // 4. Collect each typed input declared by the workflow.
      const values: Record<string, string> = {};
      for (const input of inputs) {
        const value = await promptForInput(input, provider, repo);
        if (value === undefined) {
          return; // user cancelled the flow
        }
        if (input.required && !value) {
          vscode.window.showErrorMessage(`"${input.name}" is required.`);
          return;
        }
        values[input.name] = value;
      }

      // 5. Dispatch.
      await provider.dispatchWorkflow(repo, String(workflow.id), ref, values, workflow.name);
    })
  );

  // ── Config-change listener ──
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('ghaRunsViewer.repository') ||
        e.affectsConfiguration('ghaRunsViewer.repositories') ||
        e.affectsConfiguration('ghaRunsViewer.branch')
      ) {
        provider.resetCache();
        provider.refresh();
      }
      if (e.affectsConfiguration('ghaRunsViewer.pollIntervalSeconds')) {
        // The poll timer below will pick up the new interval on its next tick
        // because it re-reads the config each time.
      }
    })
  );

  // ── Auto-refresh polling ──
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let windowActive = true;

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      windowActive = state.focused;
      if (windowActive) {
        provider.refresh();
        schedule();
      }
    })
  );

  const schedule = () => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    const config = vscode.workspace.getConfiguration('ghaRunsViewer');
    const intervalSeconds = config.get<number>('pollIntervalSeconds', 30);
    if (intervalSeconds <= 0) {
      return;
    }
    pollTimer = setTimeout(() => {
      if (windowActive) {
        provider.refresh();
      }
      schedule();
    }, intervalSeconds * 1000);
  };

  schedule();

  // ── Cleanup on deactivation ──
  context.subscriptions.push({
    dispose: () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      disposeActivePanel();
    }
  });
}

export function deactivate() {
  disposeActivePanel();
}
