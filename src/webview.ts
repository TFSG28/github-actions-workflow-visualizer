import * as vscode from 'vscode';
import type { WorkflowRun, RunJob, Annotation, LivePanelHandle } from './types';
import { RunsProvider } from './provider';
import { buildRunModel } from './graph';
import { makeNonce, escapeHtml } from './utils';

/** Track the single active run-details panel so we can clean it up before opening
 *  a new one. */
let activeRunDetailsPanel: LivePanelHandle | null = null;

export function disposeActivePanel(): void {
  if (activeRunDetailsPanel) {
    activeRunDetailsPanel.stopPoll();
    activeRunDetailsPanel.panel.dispose();
    activeRunDetailsPanel = null;
  }
}

export function showRunDetails(
  provider: RunsProvider,
  run: WorkflowRun,
  jobs: RunJob[],
  deps: Map<string, string[]> | null,
  annotationsByJob: Map<number, Annotation[]>
): void {
  disposeActivePanel();

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

  panel.webview.html = generateHtml(csp, nonce, model);

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
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const stopPoll = () => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  activeRunDetailsPanel = { panel, stopPoll };

  panel.onDidDispose(() => {
    disposed = true;
    stopPoll();
    if (activeRunDetailsPanel?.panel === panel) {
      activeRunDetailsPanel = null;
    }
  });

  const poll = async () => {
    if (disposed) {
      return;
    }
    if (!panel.visible) {
      pollTimer = setTimeout(poll, 8000);
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
      pollTimer = setTimeout(poll, 8000);
    }
  };

  if (run.status !== 'completed') {
    pollTimer = setTimeout(poll, 8000);
  }
}

function generateHtml(csp: string, nonce: string, model: ReturnType<typeof buildRunModel>): string {
  return `<!DOCTYPE html>
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
}
