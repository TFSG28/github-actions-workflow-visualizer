import { describe, it, expect } from 'vitest';
import { parseJobDependencies } from '../deps';

describe('parseJobDependencies', () => {
  it('parses inline single needs', () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('build')).toEqual([]);
    expect(deps.get('test')).toEqual(['build']);
  });

  it('parses inline list needs', () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
  test:
    needs: [lint, build]
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('test')).toEqual(['lint', 'build']);
  });

  it('parses multi-line needs list', () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
  test:
    needs:
      - lint
      - build
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('test')).toEqual(['lint', 'build']);
  });

  it('handles comments in needs block', () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs:
      # Wait for the build to finish
      - build
      # Also need lint
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('test')).toEqual(['build']);
  });

  it('handles inline needs with trailing comment', () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build  # must wait for build
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('test')).toEqual(['build']);
  });

  it('handles list item with trailing comment', () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
  test:
    needs:
      - lint  # always lint first
      - build
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('test')).toEqual(['lint', 'build']);
  });

  it('handles inline list needs with trailing comment', () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
  build:
    runs-on: ubuntu-latest
  test:
    needs: [lint, build]  # depends on both
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('test')).toEqual(['lint', 'build']);
  });

  it('returns empty deps for jobs with no needs', () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
  deploy:
    runs-on: ubuntu-latest
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('build')).toEqual([]);
    expect(deps.get('deploy')).toEqual([]);
  });

  it('stops at same indent level as jobs', () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest

name: CI
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('build')).toEqual([]);
    expect(deps.get('test')).toEqual(['build']);
  });

  it('handles single job workflow', () => {
    const yaml = `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const deps = parseJobDependencies(yaml);
    expect(deps.get('build')).toEqual([]);
    expect(deps.size).toBe(1);
  });
});
