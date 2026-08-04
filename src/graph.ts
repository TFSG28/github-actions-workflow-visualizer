import type { RunJob, WorkflowRun, Annotation, RunModel } from './types';
import { stateLabel, formatDuration, annotationIcon, escapeHtml } from './utils';
/**
 * Assigns each job a "level" (column index in the DAG) based on its
 * `needs:` dependencies. Jobs with no dependencies are level 0; jobs that
 * depend on level-N jobs go into level N+1.
 */
export function computeLevels(jobs: RunJob[], deps: Map<string, string[]> | null): Map<string, number> {
  const levels = new Map<string, number>();
  const jobNames = jobs.map((j) => j.name);

  const resolveDepName = (depId: string): string | null => {
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
    const direct = deps.get(name);
    if (direct) {
      return direct.map(resolveDepName).filter((n): n is string => !!n);
    }
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

const NODE_WIDTH = 260;
const COLUMN_GAP = 100;
const ROW_GAP = 24;
const HEADER_HEIGHT = 44;
const STEP_ROW_HEIGHT = 28;
const PADDING = 40;

/**
 * Builds a RunModel from run metadata, job list, dependencies, and annotations.
 * This is the layout engine that produces the SVG edges, HTML nodes, and all
 * the metadata consumed by the webview.
 */
export function buildRunModel(
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

  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  let maxLevel = 0;
  for (const lvl of byLevel.keys()) {
    maxLevel = Math.max(maxLevel, lvl);
  }

  for (const [lvl, jobsInLevel] of Array.from(byLevel.entries()).sort((a, b) => a[0] - b[0])) {
    let y = PADDING;
    for (const job of jobsInLevel) {
      const height = HEADER_HEIGHT + Math.max(job.steps.length, 1) * STEP_ROW_HEIGHT + 16;
      positions.set(job.name, {
        x: PADDING + lvl * (NODE_WIDTH + COLUMN_GAP),
        y,
        width: NODE_WIDTH,
        height
      });
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
        : Array.from(deps.entries()).find(
            ([jobId]) => job.name === jobId || job.name.startsWith(`${jobId} (`)
          )?.[1] || [];
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
        badges.push(
          `<span class="count-badge error">${errorCount} error${errorCount > 1 ? 's' : ''}</span>`
        );
      }
      if (warningCount > 0) {
        badges.push(
          `<span class="count-badge warning">${warningCount} warning${warningCount > 1 ? 's' : ''}</span>`
        );
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
      const location =
        ann.path && ann.path !== '.github'
          ? `${escapeHtml(ann.path)}:${ann.start_line}`
          : escapeHtml(job.name);
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
