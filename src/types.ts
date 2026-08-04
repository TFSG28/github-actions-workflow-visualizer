export interface RunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: RunStep[];
}

export interface RunStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  message: string;
  title: string | null;
}

export interface WorkflowRun {
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

export interface RunModel {
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

export interface LivePanelHandle {
  panel: import('vscode').WebviewPanel;
  /** Stop the poll timer so it won't fire after disposal. */
  stopPoll: () => void;
}
