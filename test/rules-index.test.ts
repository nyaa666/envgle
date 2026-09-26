import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuleId, Severity } from '../src/types.js';
import { SEVERITIES } from '../src/types.js';
import { allRules, getRule, isKnownRule, ruleIds, rulesBySeverity } from '../src/rules/index.js';
import { contractRules } from '../src/rules/contract.js';
import { hygieneRules } from '../src/rules/hygiene.js';

const KNOWN_IDS: readonly RuleId[] = [
  'ci-secret-undeclared',
  'compose-var-undeclared',
  'conflicting-values',
  'debug-flag-shared-env',
  'duplicate-key',
  'empty-value',
  'env-file-missing',
  'env-file-untracked',
  'example-out-of-sync',
  'expansion-unsupported',
  'export-prefix',
  'framework-prefix-mismatch',
  'hardcoded-connection-string',
  'hostile-name',
  'inline-comment-truncation',
  'invalid-name',
  'missing-from-example',
  'missing-in-env',
  'prod-crash',
  'reserved-name',
  'secret-fallback-literal',
  'secret-in-example',
  'secret-in-repo',
  'shell-incompatible-name',
  'unquoted-special-chars',
  'unterminated-quote',
  'unused-variable',
  'weak-secret',
];

const DEFAULT_SEVERITIES: Readonly<Record<string, Severity>> = {
  'missing-in-env': 'error',
  'missing-from-example': 'error',
  'unused-variable': 'warn',
  'prod-crash': 'error',
  'example-out-of-sync': 'error',
  'ci-secret-undeclared': 'warn',
  'compose-var-undeclared': 'warn',
  'env-file-missing': 'error',
  'env-file-untracked': 'error',
  'framework-prefix-mismatch': 'warn',
  'duplicate-key': 'error',
  'conflicting-values': 'warn',
  'empty-value': 'info',
  'unquoted-special-chars': 'warn',
  'inline-comment-truncation': 'warn',
  'export-prefix': 'info',
  'unterminated-quote': 'error',
  'expansion-unsupported': 'warn',
};

test('allRules exposes the 28 rule ids exactly once', () => {
  assert.equal(allRules.length, 28);
  assert.deepEqual(allRules.map((rule) => rule.id).sort(), [...KNOWN_IDS]);
  assert.equal(new Set(allRules.map((rule) => rule.id)).size, 28);
});

test('allRules lists the contract and hygiene rules in order, security rules last', () => {
  const expected = [...contractRules.map((rule) => rule.id), ...hygieneRules.map((rule) => rule.id)];
  assert.equal(expected.length, 18);
  assert.deepEqual(allRules.map((rule) => rule.id).slice(0, expected.length), expected);
});

test('every rule id is known to isKnownRule and unknown ids are rejected', () => {
  for (const id of KNOWN_IDS) {
    assert.equal(isKnownRule(id), true, `${id} should be a known rule id`);
  }
  assert.equal(isKnownRule('nope'), false);
  assert.equal(isKnownRule(''), false);
  assert.equal(isKnownRule('Missing-In-Env'), false);
});

test('ruleIds returns every id sorted', () => {
  const ids = ruleIds();

  assert.equal(ids.length, 28);
  assert.deepEqual([...ids], [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.deepEqual([...ids], KNOWN_IDS);
});

test('getRule resolves known ids and returns undefined for anything else', () => {
  for (const id of KNOWN_IDS) {
    assert.equal(getRule(id)?.id, id);
  }
  assert.equal(isKnownRule('nope'), false);
  assert.equal(getRule('nope' as RuleId), undefined);
});

test('every rule documents itself with the canonical docs anchor', () => {
  for (const rule of allRules) {
    assert.equal(rule.docs, `docs/rules.md#${rule.id}`);
    assert.equal(rule.docs.startsWith('docs/rules.md#'), true);
  }
});

test('every rule has a title, description, remediation, severity, tags and a check function', () => {
  for (const rule of allRules) {
    assert.equal(typeof rule.check, 'function', `${rule.id} needs a check function`);
    assert.equal(rule.title.trim().length > 0, true, `${rule.id} needs a title`);
    assert.equal(rule.description.trim().length > 0, true, `${rule.id} needs a description`);
    assert.equal(rule.remediation.trim().length > 0, true, `${rule.id} needs a remediation`);
    assert.equal(SEVERITIES.includes(rule.severity), true, `${rule.id} has an unknown severity`);
    assert.equal(rule.tags.length > 0, true, `${rule.id} needs at least one tag`);
  }
});

test('rulesBySeverity partitions all rules into sorted buckets', () => {
  const buckets = SEVERITIES.map((severity) => rulesBySeverity(severity));
  const combined = buckets.flat();

  assert.deepEqual(
    combined.map((rule) => rule.id).sort(),
    [...KNOWN_IDS],
  );
  assert.equal(new Set(combined.map((rule) => rule.id)).size, 28);
  buckets.forEach((bucket, index) => {
    const severity = SEVERITIES[index] as Severity;
    assert.equal(bucket.every((rule) => rule.severity === severity), true);
    assert.deepEqual(
      bucket.map((rule) => rule.id),
      [...bucket.map((rule) => rule.id)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
  assert.deepEqual(
    SEVERITIES.map((severity) => rulesBySeverity(severity).length),
    [rulesBySeverity('error').length, rulesBySeverity('warn').length, rulesBySeverity('info').length],
  );
  assert.equal(SEVERITIES.reduce((total, severity) => total + rulesBySeverity(severity).length, 0), 28);
});

test('the contract and hygiene rules ship their documented default severities', () => {
  const documented = ruleIds().filter((id) => Object.hasOwn(DEFAULT_SEVERITIES, id));

  assert.equal(documented.length, 18);
  for (const id of documented) {
    assert.equal(getRule(id)?.severity, DEFAULT_SEVERITIES[id], `${id} should default to ${DEFAULT_SEVERITIES[id]}`);
  }
});

test('rulesBySeverity returns a fresh array the caller cannot use to mutate the registry', () => {
  const first = rulesBySeverity('error');

  assert.notEqual(first, rulesBySeverity('error'));
  assert.deepEqual(first.map((rule) => rule.id), [...rulesBySeverity('error').map((rule) => rule.id)]);
});
