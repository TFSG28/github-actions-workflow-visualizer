import { parse } from 'yaml';
import type { WorkflowDispatchInput } from './types';

/**
 * The result of inspecting a workflow file for a `workflow_dispatch` trigger:
 * whether the trigger exists and the typed inputs it declares (if any).
 */
export interface WorkflowDispatchInfo {
  hasWorkflowDispatch: boolean;
  inputs: WorkflowDispatchInput[];
}

/**
 * Locate the `workflow_dispatch` entry inside a workflow's `on:` trigger block.
 * `on:` may be a string (single event), a flow sequence (`[push, workflow_dispatch]`),
 * or a map. The `workflow_dispatch` value may be empty (`workflow_dispatch:`) or a
 * map carrying an `inputs:` block.
 */
function findWorkflowDispatch(triggers: unknown): unknown {
  if (triggers == null) {
    return undefined;
  }
  if (typeof triggers === 'string') {
    return triggers === 'workflow_dispatch' ? {} : undefined;
  }
  if (Array.isArray(triggers)) {
    return triggers.some((t) => t === 'workflow_dispatch') ? {} : undefined;
  }
  if (typeof triggers === 'object') {
    const obj = triggers as Record<string, unknown>;
    if ('workflow_dispatch' in obj) {
      return obj.workflow_dispatch ?? {};
    }
  }
  return undefined;
}

export function parseWorkflowDispatch(yamlText: string): WorkflowDispatchInfo {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return { hasWorkflowDispatch: false, inputs: [] };
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { hasWorkflowDispatch: false, inputs: [] };
  }

  // `on:` is the canonical trigger key. Some files use `true:` (a YAML 1.1
  // workaround); the parser exposes that key as the string "true".
  const root = doc as Record<string, unknown>;
  const triggers = root.on ?? root.true;
  const wd = findWorkflowDispatch(triggers);
  if (wd === undefined) {
    return { hasWorkflowDispatch: false, inputs: [] };
  }

  const inputsRaw = (wd as Record<string, unknown>).inputs;
  if (!inputsRaw || typeof inputsRaw !== 'object' || Array.isArray(inputsRaw)) {
    return { hasWorkflowDispatch: true, inputs: [] };
  }

  const inputs: WorkflowDispatchInput[] = [];
  for (const [name, raw] of Object.entries(inputsRaw as Record<string, unknown>)) {
    const value = (raw ?? {}) as Record<string, unknown>;
    inputs.push({
      name,
      description: typeof value.description === 'string' ? value.description : '',
      type: typeof value.type === 'string' ? value.type : 'string',
      required: value.required === true,
      default: value.default === undefined ? null : (value.default as WorkflowDispatchInput['default']),
      options: Array.isArray(value.options) ? value.options.map((o) => String(o)) : undefined
    });
  }

  return { hasWorkflowDispatch: true, inputs };
}
