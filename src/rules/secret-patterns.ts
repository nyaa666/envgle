import type { SecretPatternConfig } from '../types.js';
import {
  DEFAULT_SECRET_NAME_PATTERN,
  fingerprint,
  isSecretishName,
  previewValue,
  shannonEntropy,
} from '../utils/text.js';

/** One credential shape: a stable id, a display name, a self-test and a false-positive guard. */
export interface DefaultSecretPattern {
  readonly id: string;
  readonly name: string;
  /** String this pattern must match (self-validation). */
  readonly test: string;
  /** String this pattern must NOT match (false-positive guard). */
  readonly negativeTest: string;
  readonly pattern: string;
  readonly secretish: boolean;
}

/** Value handed to detectSecret together with the pre-computed name classification. */
export interface SecretProbe {
  readonly value: string;
  /** Variable name the value belongs to; carried for diagnostics, never printed. */
  readonly name: string;
  readonly secretish: boolean;
}

/** Everything the rules need to know about one value, without ever exposing it. */
export interface SecretDetection {
  readonly matched: readonly DefaultSecretPattern[];
  readonly highEntropy: boolean;
  readonly fingerprint: string;
  readonly preview: string;
}

const REDACTED = '<redacted>';

/** Minimum length before entropy is meaningful for a credential. */
const HIGH_ENTROPY_MIN_LENGTH = 16;

/** Shannon entropy (bits per character) above which a value looks machine-generated. */
const HIGH_ENTROPY_MIN_BITS = 3.2;

/** Characters allowed in a base64/base32/hex-ish credential. */
const HIGH_ENTROPY_SHAPE = /^[A-Za-z0-9+/=_-]+$/;

/** Upper bound on the value length that is handed to the pattern engine. */
const MAX_SCAN_LENGTH = 8192;

const PREVIEW_LENGTH = 24;

/** Built-in credential shapes; every source is bounded-quantifier and prefilter-friendly. */
export const DEFAULT_SECRET_PATTERNS: readonly DefaultSecretPattern[] = [
  {
    id: 'aws-access-key-id',
    name: 'AWS access key id',
    test: 'AKIAIOSFODNN7EXAMPLE',
    negativeTest: 'arn:aws:iam::123456789012:user/deploy',
    pattern: '(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}',
    secretish: true,
  },
  {
    id: 'github-token',
    name: 'GitHub token',
    test: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://github.com/nyaa666/envgle',
    pattern: '(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})',
    secretish: true,
  },
  {
    id: 'gitlab-token',
    name: 'GitLab personal access token',
    test: 'glpat-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://gitlab.com/gitlab-org/gitlab',
    pattern: 'glpat-[A-Za-z0-9_-]{20,}',
    secretish: true,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    test: 'xoxb-000000000000-000000000000-aaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://api.slack.com/authentication/basics',
    pattern: 'xox[abposr]-[A-Za-z0-9-]{10,}',
    secretish: true,
  },
  {
    id: 'slack-webhook',
    name: 'Slack incoming webhook',
    test: 'https://hooks.slack.com/services/T00000000/B00000000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://hooks.slack.com/',
    pattern: 'https://hooks\\.slack\\.com/services/T[A-Za-z0-9_]+/B[A-Za-z0-9_]+/[A-Za-z0-9_]+',
    secretish: true,
  },
  {
    id: 'stripe-secret-key',
    name: 'Stripe live secret key',
    test: 'sk_live_aaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
    pattern: '[rs]k_live_[A-Za-z0-9]{16,}',
    secretish: true,
  },
  {
    id: 'stripe-test-key',
    name: 'Stripe test key',
    test: 'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
    negativeTest: 'sk_live_4eC39HqLyjWDarjtT1zdp7dc',
    pattern: '[rs]k_test_[A-Za-z0-9]{16,}',
    secretish: true,
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    test: 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    negativeTest: 'https://cloud.google.com/docs/authentication/api-keys',
    pattern: 'AIza[0-9A-Za-z_-]{35}',
    secretish: true,
  },
  {
    id: 'google-oauth',
    name: 'Google OAuth access token',
    test: 'ya29.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    negativeTest: 'https://developers.google.com/identity/protocols/oauth2',
    pattern: 'ya29\\.[0-9A-Za-z_-]{20,}',
    secretish: true,
  },
  {
    id: 'openai-key',
    name: 'OpenAI API key',
    test: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
    pattern: 'sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}',
    secretish: true,
  },
  {
    id: 'anthropic-key',
    name: 'Anthropic API key',
    test: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://docs.anthropic.com/en/api/getting-started',
    pattern: 'sk-ant-[A-Za-z0-9_-]{20,}',
    secretish: true,
  },
  {
    id: 'openrouter-key',
    name: 'OpenRouter API key',
    test: 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://openrouter.ai/docs/quickstart',
    pattern: 'sk-or-v1-[A-Za-z0-9]{32,}',
    secretish: true,
  },
  {
    id: 'groq-key',
    name: 'Groq API key',
    test: 'gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://console.groq.com/docs/quickstart',
    pattern: 'gsk_[A-Za-z0-9]{40,}',
    secretish: true,
  },
  {
    id: 'huggingface-token',
    name: 'Hugging Face access token',
    test: 'hf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://huggingface.co/docs/hub/security-tokens',
    pattern: 'hf_[A-Za-z0-9]{30,}',
    secretish: true,
  },
  {
    id: 'sendgrid-key',
    name: 'SendGrid API key',
    test: 'SG.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb',
    negativeTest: 'https://app.sendgrid.com/settings/api_keys',
    pattern: 'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    secretish: true,
  },
  {
    id: 'mailgun-key',
    name: 'Mailgun API key',
    test: 'key-00000000000000000000000000000000',
    negativeTest: 'https://documentation.mailgun.com/en/latest/user-secrets.html',
    pattern: 'key-[0-9a-f]{32}',
    secretish: true,
  },
  {
    id: 'mailchimp-key',
    name: 'Mailchimp API key',
    test: '00000000000000000000000000000000-us20',
    negativeTest: '9fceb02d0ae598e95dc970b74767f19372d61af8',
    pattern: '\\b[0-9a-f]{32}-us[0-9]{1,2}\\b',
    secretish: true,
  },
  {
    id: 'twilio-key',
    name: 'Twilio account SID or auth token',
    test: 'SK00000000000000000000000000000000',
    negativeTest: 'https://www.twilio.com/docs/usage/rest-api',
    pattern: '\\bSK[0-9a-fA-F]{32}\\b',
    secretish: true,
  },
  {
    id: 'telegram-bot-token',
    name: 'Telegram bot token',
    test: '123456789:AAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://core.telegram.org/bots/api',
    pattern: '[0-9]{8,12}:AA[A-Za-z0-9_-]{30,}',
    secretish: true,
  },
  {
    id: 'npm-token',
    name: 'npm access token',
    test: 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://docs.npmjs.com/about-npm',
    pattern: 'npm_[A-Za-z0-9]{30,}',
    secretish: true,
  },
  {
    id: 'pypi-token',
    name: 'PyPI upload token',
    test: 'pypi-AgEIcHlwaS5vcmcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    negativeTest: 'https://pypi.org/help/#apitoken',
    pattern: 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}',
    secretish: true,
  },
  {
    id: 'dockerhub-password',
    name: 'Docker Hub access token',
    test: 'dckr_pat_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://docs.docker.com/docker-hub/access-tokens/',
    pattern: 'dckr_pat_[A-Za-z0-9_-]{20,}',
    secretish: true,
  },
  {
    id: 'linear-key',
    name: 'Linear API key',
    test: 'lin_api_aaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://linear.app/docs/api',
    pattern: 'lin_api_[A-Za-z0-9]{20,}',
    secretish: true,
  },
  {
    id: 'supabase-key',
    name: 'Supabase secret key',
    test: 'sbp_0000000000000000000000000000000000000000',
    negativeTest: 'https://supabase.com/docs/guides/api/api-keys',
    pattern: 'sbp_[a-f0-9]{32,}',
    secretish: true,
  },
  {
    id: 'firebase-key',
    name: 'Firebase database secret',
    test:
      'AAAAabcdefg:APA91baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    negativeTest: 'https://firebase.google.com/docs/database',
    pattern: 'AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{100,}',
    secretish: true,
  },
  {
    id: 'azure-storage-key',
    name: 'Azure storage account key',
    test: 'AccountKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    negativeTest: 'DefaultEndpointsProtocol=https;AccountName=devstoreaccount1;AccountKey=disabled',
    pattern: 'AccountKey=[A-Za-z0-9+/=]{60,}',
    secretish: true,
  },
  {
    id: 'private-key-block',
    name: 'PEM private key block',
    test: '-----BEGIN RSA PRIVATE KEY-----',
    negativeTest: '-----BEGIN PUBLIC KEY-----',
    pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    secretish: true,
  },
  {
    id: 'jwt',
    name: 'JSON Web Token',
    test: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    negativeTest: 'io.company.platform_service.v2.InternalClientFactory',
    pattern: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{5,}',
    secretish: true,
  },
  {
    id: 'connection-string-password',
    name: 'Database connection string with password',
    test: 'postgres://appuser:PLACEHOLDER_PASSWORD_1@example.com:5432/appdb',
    negativeTest: 'postgres://localhost:5432/appdb',
    pattern:
      '(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis(?:s)?|amqps?|mssql|clickhouse)://[^\\s:/@]{1,128}:[^\\s:/@]{3,128}@',
    secretish: true,
  },
  {
    id: 'basic-auth-url',
    name: 'URL with basic-auth password',
    test: 'https://admin:PLACEHOLDER_PASSWORD_1@example.com/status',
    negativeTest: 'http://localhost:3000',
    pattern: 'https?://[^\\s:/@]{1,128}:[^\\s:/@]{3,128}@[^\\s/]',
    secretish: true,
  },
];

const regexCache = new Map<string, RegExp | null>();

const compilePattern = (source: string): RegExp | null => {
  const cached = regexCache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(source);
  } catch {
    compiled = null;
  }
  regexCache.set(source, compiled);
  return compiled;
};

const safeTest = (regex: RegExp, value: string): boolean => {
  try {
    return regex.test(value);
  } catch {
    return false;
  }
};

const toPattern = (config: SecretPatternConfig): DefaultSecretPattern | null => {
  const regex = compilePattern(config.pattern);
  if (regex === null) {
    return null;
  }
  if (config.test !== undefined && !safeTest(regex, config.test)) {
    return null;
  }
  return {
    id: config.id,
    name: config.name,
    test: config.test ?? '',
    negativeTest: '',
    pattern: config.pattern,
    secretish: config.secretish ?? true,
  };
};

const isHighEntropy = (value: string, secretish: boolean, weakValues: ReadonlySet<string>): boolean => {
  if (!secretish || value.length < HIGH_ENTROPY_MIN_LENGTH || value.length > MAX_SCAN_LENGTH) {
    return false;
  }
  if (!HIGH_ENTROPY_SHAPE.test(value)) {
    return false;
  }
  if (shannonEntropy(value) < HIGH_ENTROPY_MIN_BITS) {
    return false;
  }
  return !weakValues.has(value.trim().toLowerCase());
};

const compareIds = (a: DefaultSecretPattern, b: DefaultSecretPattern): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Compiles configured patterns on top of DEFAULT_SECRET_PATTERNS, dropping invalid ones. */
export function buildSecretPatterns(overrides: readonly SecretPatternConfig[]): readonly DefaultSecretPattern[] {
  const byId = new Map<string, DefaultSecretPattern>();
  for (const base of DEFAULT_SECRET_PATTERNS) {
    byId.set(base.id, base);
  }
  for (const override of overrides) {
    const pattern = toPattern(override);
    if (pattern !== null) {
      byId.set(override.id, pattern);
    }
  }
  return [...byId.values()].sort(compareIds);
}

/** True when a variable name looks like a secret, falling back to the built-in pattern. */
export function isSecretishVariableName(name: string, pattern: string): boolean {
  try {
    return isSecretishName(name, pattern);
  } catch {
    return isSecretishName(name, DEFAULT_SECRET_NAME_PATTERN);
  }
}

/** Classifies one value against the pattern set; values longer than 8192 characters are never scanned. */
export function detectSecret(
  probe: SecretProbe,
  patterns: readonly DefaultSecretPattern[],
  weakValues: ReadonlySet<string> = new Set<string>(),
): SecretDetection {
  const value = probe.value;
  const scannable = value.length > 0 && value.length <= MAX_SCAN_LENGTH;
  const matched: DefaultSecretPattern[] = [];
  if (scannable) {
    for (const pattern of patterns) {
      const regex = compilePattern(pattern.pattern);
      if (regex !== null && safeTest(regex, value)) {
        matched.push(pattern);
      }
    }
  }
  return {
    matched,
    highEntropy: isHighEntropy(value, probe.secretish, weakValues),
    fingerprint: fingerprint(value),
    preview: probe.secretish ? REDACTED : previewValue(value, { secretish: false, maxLength: PREVIEW_LENGTH }),
  };
}
