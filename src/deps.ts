/**
 * Parses YAML workflow text to extract job dependency relationships from
 * `needs:` declarations. Handles inline list/single-value, multi-line list,
 * and comments inside the needs block.
 */
export function parseJobDependencies(yamlText: string): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  const lines = yamlText.split('\n');

  let jobsIndent = -1;
  let jobIndent = -1;
  let currentJob: string | null = null;
  let inNeedsBlock = false;

  const indentOf = (line: string) => line.length - line.trimStart().length;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // Allow comment lines inside a needs list block without breaking out.
      continue;
    }
    const indent = indentOf(raw);

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
    const inlineNeeds = trimmed.match(/^needs:\s*\[(.*)\]\s*(?:#.*)?$/);
    if (inlineNeeds) {
      const items = inlineNeeds[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      deps.set(currentJob, items);
      inNeedsBlock = false;
      continue;
    }
    const scalarNeeds = trimmed.match(/^needs:\s*([A-Za-z0-9_-]+)\s*(?:#.*)?$/);
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
      // Support list items with optional trailing comments:  - job_name  # comment
      const listItem = trimmed.match(/^-\s*([A-Za-z0-9_-]+)\s*(?:#.*)?$/);
      if (listItem) {
        deps.get(currentJob)!.push(listItem[1]);
        continue;
      }
      inNeedsBlock = false;
    }
  }

  return deps;
}
