import * as vscode from 'vscode';
import { RunsProvider, RunItem, getOutputChannel } from './provider';
import { showRunDetails, disposeActivePanel } from './webview';
import { TOKEN_SECRET_KEY } from './utils';

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

    // ── Dispatch workflow ──
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
        { placeHolder: 'Select repository to dispatch a workflow on' }
      );
      if (!repoSel) {
        return;
      }
      const repo = repoSel.label;
      const workflowId = await vscode.window.showInputBox({
        prompt: 'Workflow file name or ID (e.g. "ci.yml" or numeric ID)',
        placeHolder: 'ci.yml',
        ignoreFocusOut: true
      });
      if (!workflowId) {
        return;
      }
      const ref = await vscode.window.showInputBox({
        prompt: 'Git ref (branch or tag) to dispatch on',
        value: 'main',
        ignoreFocusOut: true
      });
      if (!ref) {
        return;
      }
      // Optional inputs
      const inputsStr = await vscode.window.showInputBox({
        prompt: 'Optional JSON inputs (e.g. {"name": "value"}), or leave empty',
        placeHolder: '{}',
        ignoreFocusOut: true
      });
      let inputs: Record<string, string> | null = null;
      if (inputsStr && inputsStr.trim()) {
        try {
          inputs = JSON.parse(inputsStr);
        } catch {
          vscode.window.showErrorMessage('Invalid JSON for inputs.');
          return;
        }
      }
      await provider.dispatchWorkflow(repo, workflowId, ref, inputs);
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
