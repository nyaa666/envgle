import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SecretPatternConfig } from '../src/types.js';
import {
  DEFAULT_SECRET_PATTERNS,
  buildSecretPatterns,
  detectSecret,
  isSecretishVariableName,
} from '../src/rules/secret-patterns.js';

const NAME_PATTERN = '(SECRET|TOKEN|PASSWORD|API_?KEY|AUTH_?KEY|DATABASE_?URL)';
const NO_WEAK_VALUES = new Set<string>();

const compile = (source: string): RegExp => new RegExp(source);

const patternById = (id: string) => {
  const entry = DEFAULT_SECRET_PATTERNS.find((candidate) => candidate.id === id);
  assert.ok(entry, `pattern ${id} exists`);
  return entry;
};

describe('DEFAULT_SECRET_PATTERNS', () => {
  test('every pattern matches its own test string', () => {
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      assert.equal(
        compile(entry.pattern).test(entry.test),
        true,
        `${entry.id}: pattern must match its test ${JSON.stringify(entry.test)}`,
      );
    }
  });

  test('no pattern matches its negative test string', () => {
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      assert.equal(
        compile(entry.pattern).test(entry.negativeTest),
        false,
        `${entry.id}: pattern must not match its negativeTest ${JSON.stringify(entry.negativeTest)}`,
      );
    }
  });

  test('ids are unique and every entry is complete', () => {
    const ids = DEFAULT_SECRET_PATTERNS.map((entry) => entry.id);
    assert.deepEqual([...new Set(ids)].sort(), [...ids].sort());
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      assert.equal(entry.name.length > 0, true, `${entry.id}: needs a human name`);
      assert.equal(entry.test.length > 0, true, `${entry.id}: needs a test string`);
      assert.equal(entry.negativeTest.length > 0, true, `${entry.id}: needs a negative test string`);
      assert.equal(typeof entry.secretish, 'boolean', `${entry.id}: needs a secretish flag`);
    }
  });

  test('covers every credential family the documentation promises', () => {
    const required = [
      'aws-access-key-id',
      'github-token',
      'gitlab-token',
      'slack-token',
      'slack-webhook',
      'stripe-secret-key',
      'google-api-key',
      'google-oauth',
      'openai-key',
      'anthropic-key',
      'openrouter-key',
      'groq-key',
      'huggingface-token',
      'sendgrid-key',
      'mailgun-key',
      'mailchimp-key',
      'twilio-key',
      'telegram-bot-token',
      'npm-token',
      'pypi-token',
      'dockerhub-password',
      'linear-key',
      'supabase-key',
      'firebase-key',
      'azure-storage-key',
      'private-key-block',
      'jwt',
      'connection-string-password',
      'basic-auth-url',
    ];
    const ids = DEFAULT_SECRET_PATTERNS.map((entry) => entry.id);
    for (const id of required) {
      assert.equal(ids.includes(id), true, `missing required pattern ${id}`);
    }
  });

  test('every pattern is marked secretish, so no value is ever printed', () => {
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      assert.equal(entry.secretish, true, `${entry.id}: must be secretish`);
    }
  });

  test('covers the documented alternative token prefixes', () => {
    const github = compile(patternById('github-token').pattern);
    assert.equal(github.test('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
    assert.equal(github.test('gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
    assert.equal(github.test('github_pat_11AA00ZZZZ0000yyyyyyyyyyyyyyyy'), true);
  });

  test('keeps the OpenAI and Anthropic shapes apart', () => {
    const openai = compile(patternById('openai-key').pattern);
    const anthropic = patternById('anthropic-key');
    const literal = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.equal(openai.test(literal), false);
    assert.equal(compile(anthropic.pattern).test(literal), true);
  });

  test('keeps live and test Stripe keys apart', () => {
    const live = compile(patternById('stripe-secret-key').pattern);
    const testKey = compile(patternById('stripe-test-key').pattern);
    assert.equal(live.test('sk_test_4eC39HqLyjWDarjtT1zdp7dc'), false);
    assert.equal(live.test('sk_live_4eC39HqLyjWDarjtT1zdp7dc'), true);
    assert.equal(testKey.test('sk_live_4eC39HqLyjWDarjtT1zdp7dc'), false);
    assert.notEqual(patternById('stripe-test-key').id, patternById('stripe-secret-key').id);
  });

  test('does not mistake a clean URL for a credential', () => {
    const basicAuth = compile(patternById('basic-auth-url').pattern);
    const connection = compile(patternById('connection-string-password').pattern);
    for (const clean of [
      'http://localhost:3000',
      'https://localhost:3000/health',
      'https://user@example.com',
      'postgres://localhost:5432/appdb',
      'redis://cache.internal:6379/0',
      'amqp://guest@rabbit.internal',
    ]) {
      assert.equal(basicAuth.test(clean), false, `basic-auth-url must ignore ${clean}`);
      assert.equal(connection.test(clean), false, `connection-string-password must ignore ${clean}`);
    }
    assert.equal(connection.test('postgres://appuser:PLACEHOLDER_PASSWORD_1@example.com:5432/appdb'), true);
    assert.equal(connection.test('mongodb+srv://svc:PASSWORDPH@example.com/app'), true);
  });

  test('does not mistake a dotted identifier for a JWT', () => {
    const jwt = compile(patternById('jwt').pattern);
    for (const clean of [
      'io.company.platform_service.v2.InternalClientFactory',
      'com.example.service.impl',
      'eyJ',
    ]) {
      assert.equal(jwt.test(clean), false, `jwt must ignore ${clean}`);
    }
  });
});

describe('buildSecretPatterns', () => {
  const override = (config: SecretPatternConfig) => config;

  test('returns exactly the defaults when there are no overrides', () => {
    const built = buildSecretPatterns([]);
    assert.deepEqual(
      built.map((pattern) => pattern.id).sort(),
      DEFAULT_SECRET_PATTERNS.map((pattern) => pattern.id).sort(),
    );
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      assert.deepEqual(built.find((pattern) => pattern.id === entry.id), entry);
    }
  });

  test('appends a valid override', () => {
    const patterns = buildSecretPatterns([override({ id: 'acme', name: 'Acme token', pattern: 'acme_[0-9]{6}', test: 'acme_123456' })]);
    assert.equal(patterns.length, DEFAULT_SECRET_PATTERNS.length + 1);
    const appended = patterns.find((pattern) => pattern.id === 'acme');
    assert.ok(appended);
    assert.equal(appended.name, 'Acme token');
    assert.equal(appended.secretish, true);
  });

  test('an override with a known id replaces the default', () => {
    const patterns = buildSecretPatterns([override({ id: 'jwt', name: 'Local JWT', pattern: 'local\\.token=[0-9]+', test: 'local.token=42' })]);
    assert.equal(patterns.length, DEFAULT_SECRET_PATTERNS.length);
    const replaced = patterns.find((pattern) => pattern.id === 'jwt');
    assert.ok(replaced);
    assert.equal(replaced.name, 'Local JWT');
    assert.equal(compile(replaced.pattern).test('local.token=42'), true);
  });

  test('honours secretish: false on an override', () => {
    const patterns = buildSecretPatterns([override({ id: 'acme', name: 'Acme', pattern: 'acme_[0-9]{6}', test: 'acme_123456', secretish: false })]);
    assert.equal(patterns.find((pattern) => pattern.id === 'acme')?.secretish, false);
  });

  test('drops an override whose pattern does not compile', () => {
    const patterns = buildSecretPatterns([
      override({ id: 'broken', name: 'Broken', pattern: '([unclosed', test: 'anything' }),
    ]);
    assert.equal(
      patterns.some((pattern) => pattern.id === 'broken'),
      false,
    );
    assert.equal(patterns.length, DEFAULT_SECRET_PATTERNS.length);
  });

  test('drops an override that fails its own test', () => {
    const patterns = buildSecretPatterns([
      override({ id: 'liar', name: 'Liar', pattern: 'acme_[0-9]{6}', test: 'not-an-acme-token' }),
    ]);
    assert.equal(
      patterns.some((pattern) => pattern.id === 'liar'),
      false,
    );
  });

  test('keeps an override without a test string', () => {
    const patterns = buildSecretPatterns([override({ id: 'untested', name: 'Untested', pattern: 'zzz_[0-9]+' })]);
    const kept = patterns.find((pattern) => pattern.id === 'untested');
    assert.ok(kept);
    assert.equal(kept.test, '');
    assert.equal(kept.negativeTest, '');
  });

  test('is sorted by id and deterministic', () => {
    const overrides = [
      override({ id: 'zeta', name: 'Zeta', pattern: 'z_[0-9]+', test: 'z_1' }),
      override({ id: 'alpha', name: 'Alpha', pattern: 'a_[0-9]+', test: 'a_1' }),
      override({ id: 'broken', name: 'Broken', pattern: '([', test: 'x' }),
    ];
    const first = buildSecretPatterns(overrides);
    const second = buildSecretPatterns([...overrides].reverse());
    const ids = first.map((pattern) => pattern.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(first, second);
    assert.equal(ids.includes('alpha'), true);
    assert.equal(ids.indexOf('alpha') < ids.indexOf('aws-access-key-id'), true);
  });
});

describe('redos safety', () => {
  test('the whole pattern set stays fast on a 100 KB adversarial string', () => {
    const cycle = "aaaaa':://==";
    const adversarial = cycle.repeat(Math.ceil(102400 / cycle.length)).slice(0, 102400);
    const started = process.hrtime.bigint();
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      compile(entry.pattern).test(adversarial);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(elapsedMs < 300, true, `pattern set took ${elapsedMs.toFixed(1)} ms on 100 KB of adversarial input`);
  });

  test('a single long unpunctuated value does not blow up either', () => {
    const value = 'a'.repeat(102400);
    const started = process.hrtime.bigint();
    for (const entry of DEFAULT_SECRET_PATTERNS) {
      compile(entry.pattern).test(value);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(elapsedMs < 300, true, `pattern set took ${elapsedMs.toFixed(1)} ms on 100 KB of unpunctuated input`);
  });

  test('repeating a known literal prefix is not quadratic', () => {
    const seeds = ['A', 'AAAA', 'AAAAa', 'AccountKey=', 'a+.a', 'a:@', 'xoxb-0000', 'eyJaaaa.bbbb.cccc'];
    for (const seed of seeds) {
      const value = seed.repeat(Math.ceil(102400 / seed.length)).slice(0, 102400);
      const started = process.hrtime.bigint();
      for (const entry of DEFAULT_SECRET_PATTERNS) {
        compile(entry.pattern).test(value);
      }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(elapsedMs < 300, true, `pattern set took ${elapsedMs.toFixed(1)} ms on 100 KB of ${seed}`);
    }
  });
});

describe('isSecretishVariableName', () => {
  test('classifies obvious secret names', () => {
    assert.equal(isSecretishVariableName('API_KEY', NAME_PATTERN), true);
    assert.equal(isSecretishVariableName('database_url', NAME_PATTERN), true);
    assert.equal(isSecretishVariableName('AUTH_TOKEN', NAME_PATTERN), true);
  });

  test('leaves ordinary names alone', () => {
    assert.equal(isSecretishVariableName('PORT', NAME_PATTERN), false);
  });

  test('is case insensitive, like the default pattern', () => {
    assert.equal(isSecretishVariableName('api_key', NAME_PATTERN), true);
  });

  test('falls back to the built-in pattern when the configured one is broken', () => {
    assert.equal(isSecretishVariableName('API_KEY', '([unclosed'), true);
    assert.equal(isSecretishVariableName('PORT', '([unclosed'), false);
  });
});

describe('detectSecret', () => {
  test('reports the matching pattern and redacts the value', () => {
    const detection = detectSecret(
      { value: 'AKIAIOSFODNN7EXAMPLE', name: 'AWS_ACCESS_KEY_ID', secretish: true },
      DEFAULT_SECRET_PATTERNS,
    );
    assert.deepEqual(
      detection.matched.map((pattern) => pattern.id),
      ['aws-access-key-id'],
    );
    assert.equal(detection.preview, '<redacted>');
    assert.match(detection.fingerprint, /^[0-9a-f]{12}$/);
  });

  test('names every pattern that matched', () => {
    const detection = detectSecret(
      { value: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'ANTHROPIC_KEY', secretish: true },
      DEFAULT_SECRET_PATTERNS,
    );
    assert.equal(detection.matched.length >= 1, true);
  });

  test('flags a high-entropy secretish value without a pattern match', () => {
    const detection = detectSecret(
      { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', name: 'AWS_SECRET_ACCESS_KEY', secretish: true },
      DEFAULT_SECRET_PATTERNS,
      NO_WEAK_VALUES,
    );
    assert.deepEqual(detection.matched, []);
    assert.equal(detection.highEntropy, true);
    assert.equal(detection.preview, '<redacted>');
  });

  test('does not flag high entropy for a value that is not secretish', () => {
    const detection = detectSecret(
      { value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', name: 'BUILD_STAMP', secretish: false },
      DEFAULT_SECRET_PATTERNS,
      NO_WEAK_VALUES,
    );
    assert.equal(detection.highEntropy, false);
  });

  test('does not flag high entropy for a short or low-entropy value', () => {
    for (const value of ['s3cret', 'aaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      const detection = detectSecret({ value, name: 'API_KEY', secretish: true }, DEFAULT_SECRET_PATTERNS, NO_WEAK_VALUES);
      assert.equal(detection.highEntropy, false, `${value} must not look like a secret`);
    }
  });

  test('respects the weak-value list', () => {
    const value = 'ThisIsAVeryLongWeakValue';
    const strong = detectSecret({ value, name: 'API_KEY', secretish: true }, DEFAULT_SECRET_PATTERNS, NO_WEAK_VALUES);
    const weak = detectSecret(
      { value, name: 'API_KEY', secretish: true },
      DEFAULT_SECRET_PATTERNS,
      new Set([value.toLowerCase()]),
    );
    assert.equal(strong.highEntropy, true);
    assert.equal(weak.highEntropy, false);
  });

  test('previews a non-secret value and truncates it', () => {
    assert.equal(detectSecret({ value: '3000', name: 'PORT', secretish: false }, DEFAULT_SECRET_PATTERNS).preview, '3000');
    const long = 'x'.repeat(40);
    const preview = detectSecret({ value: long, name: 'HOST', secretish: false }, DEFAULT_SECRET_PATTERNS).preview;
    assert.equal(preview.length <= 24, true);
  });

  test('ignores absurdly long values instead of running the patterns', () => {
    const detection = detectSecret(
      { value: `AKIA${'A'.repeat(9000)}`, name: 'AWS_ACCESS_KEY_ID', secretish: true },
      DEFAULT_SECRET_PATTERNS,
      NO_WEAK_VALUES,
    );
    assert.deepEqual(detection.matched, []);
    assert.equal(detection.highEntropy, false);
    assert.equal(detection.preview, '<redacted>');
  });

  test('an empty value matches nothing but still has a fingerprint', () => {
    const detection = detectSecret({ value: '', name: 'API_KEY', secretish: true }, DEFAULT_SECRET_PATTERNS, NO_WEAK_VALUES);
    assert.deepEqual(detection.matched, []);
    assert.equal(detection.highEntropy, false);
    assert.match(detection.fingerprint, /^[0-9a-f]{12}$/);
  });

  test('a hostile override cannot make the matcher throw', () => {
    const hostile = buildSecretPatterns([{ id: 'evil', name: 'Evil', pattern: '([', test: 'x' }]);
    const detection = detectSecret({ value: 'AKIAIOSFODNN7EXAMPLE', name: 'AWS_ACCESS_KEY_ID', secretish: true }, hostile, NO_WEAK_VALUES);
    assert.deepEqual(
      detection.matched.map((pattern) => pattern.id),
      ['aws-access-key-id'],
    );
  });
});
