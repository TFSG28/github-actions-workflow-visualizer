// Minimal, framework-free self-check for the GitHub Actions expression grammar.
// Verifies the grammar is wired into package.json and that its key regexes
// actually match / reject representative expression snippets. Run: node scripts/check-grammar.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const grammar = JSON.parse(readFileSync(new URL('../syntaxes/github-actions-expressions.tmLanguage.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

// 1. Wiring: package.json references the grammar and injects into YAML.
const g = (pkg.contributes.grammars || []).find((x) => x.scopeName === grammar.scopeName);
assert.ok(g, 'grammar not registered in package.json');
assert.deepEqual(g.injectTo, ['source.yaml'], 'grammar must inject into source.yaml');
assert.equal(grammar.injectionSelector, 'L:source.yaml', 'injectionSelector must target source.yaml');

// 2. Regex behaviour on representative snippets.
const rx = (name) => new RegExp(grammar.repository[name].match || grammar.repository[name].begin);
const begin = new RegExp(grammar.repository.expression.begin);
assert.ok(begin.test('${{ github.event_name }}'), 'should detect an expression opener');
assert.ok(!begin.test('plain: value'), 'should not fire on plain yaml');

assert.ok(rx('function').test('contains(github.ref, "main")'), 'contains() is a function');
assert.ok(!rx('function').test('containsFoo bar'), 'bare word is not a function call');
assert.ok(rx('context').test('steps.build.outputs.x'), 'steps is a context');
assert.ok(rx('operator').test('a == b'), 'operator match');
assert.ok(rx('constant').test('true'), 'boolean literal');

console.log('grammar check: OK');
