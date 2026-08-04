import * as vscode from 'vscode';

/** Secret-storage key for the GitHub token. */
export const TOKEN_SECRET_KEY = 'ghaRunsViewer.githubToken';

export function iconForState(status: string, conclusion: string | null): vscode.ThemeIcon {
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

export function stateLabel(status: string, conclusion: string | null): string {
  if (status !== 'completed') {
    return status;
  }
  return conclusion || 'unknown';
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
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

export function annotationIcon(level: string): string {
  if (level === 'failure' || level === 'error') {
    return 'error';
  }
  if (level === 'warning') {
    return 'warning';
  }
  return 'notice';
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
