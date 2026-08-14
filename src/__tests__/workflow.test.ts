import { describe, it, expect } from 'vitest';
import { parseWorkflowDispatch } from '../workflow';

describe('parseWorkflowDispatch', () => {
  it('detects a workflow_dispatch trigger with no inputs', () => {
    const yaml = `name: CI\non:\n  workflow_dispatch:\n`;
    const info = parseWorkflowDispatch(yaml);
    expect(info.hasWorkflowDispatch).toBe(true);
    expect(info.inputs).toEqual([]);
  });

  it('parses choice, boolean, string and environment inputs', () => {
    const yaml = `
name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Where to deploy'
        type: choice
        required: true
        default: staging
        options:
          - dev
          - staging
          - production
      dryRun:
        description: 'Preview only'
        type: boolean
        default: false
      message:
        description: 'Release notes'
        type: string
        required: true
      target:
        description: 'Deployment environment'
        type: environment
`;
    const info = parseWorkflowDispatch(yaml);
    expect(info.hasWorkflowDispatch).toBe(true);
    expect(info.inputs).toEqual([
      {
        name: 'environment',
        description: 'Where to deploy',
        type: 'choice',
        required: true,
        default: 'staging',
        options: ['dev', 'staging', 'production']
      },
      {
        name: 'dryRun',
        description: 'Preview only',
        type: 'boolean',
        required: false,
        default: false,
        options: undefined
      },
      {
        name: 'message',
        description: 'Release notes',
        type: 'string',
        required: true,
        default: null,
        options: undefined
      },
      {
        name: 'target',
        description: 'Deployment environment',
        type: 'environment',
        required: false,
        default: null,
        options: undefined
      }
    ]);
  });

  it('handles flow-sequence options and inline workflow_dispatch in a list of triggers', () => {
    const yaml = `
on: [push, workflow_dispatch]
`;
    const info = parseWorkflowDispatch(yaml);
    expect(info.hasWorkflowDispatch).toBe(true);
    expect(info.inputs).toEqual([]);
  });

  it('handles a single string trigger without workflow_dispatch', () => {
    const yaml = `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n`;
    const info = parseWorkflowDispatch(yaml);
    expect(info.hasWorkflowDispatch).toBe(false);
  });

  it('handles a map of triggers without workflow_dispatch', () => {
    const yaml = `on:\n  push:\n    branches: [main]\n`;
    const info = parseWorkflowDispatch(yaml);
    expect(info.hasWorkflowDispatch).toBe(false);
  });

  it('treats the true: alias as the trigger key', () => {
    const yaml = `true:\n  workflow_dispatch:\n    inputs:\n      level:\n        type: choice\n        options: [low, high]\n`;
    const info = parseWorkflowDispatch(yaml);
    expect(info.hasWorkflowDispatch).toBe(true);
    expect(info.inputs).toHaveLength(1);
    expect(info.inputs[0].options).toEqual(['low', 'high']);
  });

  it('returns no dispatch for invalid YAML', () => {
    const info = parseWorkflowDispatch('on: [unclosed');
    expect(info.hasWorkflowDispatch).toBe(false);
    expect(info.inputs).toEqual([]);
  });

  it('returns no dispatch for empty input', () => {
    const info = parseWorkflowDispatch('');
    expect(info.hasWorkflowDispatch).toBe(false);
  });
});
