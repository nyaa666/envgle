import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  EnvFileInfo,
  EnvFileKind,
  EnvUsage,
  EnvVarDecl,
  FindingInput,
  ResolvedConfig,
  Rule,
  RuleContext,
  RuleId,
  SourceLocation,
} from '../src/types.js';
import { DEFAULT_SECRET_NAME_PATTERN, fingerprint } from '../src/utils/text.js';
import { securityRules } from '../src/rules/security.js';

const WEAK_VALUES = [
  'changeme',
  'change_me',
  'change-me',
  'password',
  'passwd',
  'secret',
  'admin',
  'root',
  'test',
  'testing',
  'example',
  'placeholder',
  'todo',
  'tbd',
  'fixme',
  'your-password',
  'your_secret',
  'your-api-key',
  'my-secret',
  'abc123',
  '123456',
  '12345678',
  'qwerty',
  'letmein',
  'hunter2',
  'default',
  'undefined',
  'null',
  'none',
  'empty',
  'insert-key-here',
];

const RESERVED_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'HOSTNAME',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'DISPLAY',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'NODE_PATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'GEM_HOME',
  'CARGO_HOME',
];

const HOSTILE_NAMES = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_ROOT_PATH',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'PS4',
  'PROMPT_COMMAND',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONWARNINGS',
  'GLIBC_TUNABLES',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'NODE_PATH',
  'PATH',
  'LD_DEBUG',
];

const AWS_EXAMPLE_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const AWS_EXAMPLE_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const GITHUB_EXAMPLE_TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STRIPE_EXAMPLE_TEST_KEY = 'sk_test_4eC39HqLyjWDarjtT1zdp7dc';
const CONNECTION_WITH_PASSWORD = 'postgres://appuser:PLACEHOLDER_PASSWORD_1@db.internal:5432/appdb';
const CONNECTION_PLACEHOLDER = 'postgres://appuser:password@localhost:5432/appdb';

const baseConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  include: [],
  exclude: [],
  envFiles: ['.env', '.env.*'],
  exampleFiles: ['.env.example'],
  ignoreRules: new Set<RuleId>(),
  ignoreVariables: [],
  ignoreFingerprints: new Set<string>(),
  severities: {},
  weakValues: new Set(WEAK_VALUES),
  hostileNames: new Set(HOSTILE_NAMES),
  reservedNames: new Set(RESERVED_NAMES),
  secretPatterns: [],
  secretNamePattern: DEFAULT_SECRET_NAME_PATTERN,
  maxFileSizeBytes: 512000,
  maxLineLength: 4000,
  ciEnvironmentKinds: {},
  failOn: 'error',
  codeFrameLines: 2,
  followSymlinks: false,
  requireExampleFile: false,
  source: null,
  warnings: [],
  ...overrides,
});

interface DeclInit {
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly value?: string;
  readonly kind?: EnvFileKind;
  readonly shared?: boolean;
  readonly devOnly?: boolean;
}

const makeDecl = (init: DeclInit): EnvVarDecl => {
  const value = init.value ?? '';
  return {
    name: init.name,
    file: init.file ?? '.env',
    line: init.line ?? 1,
    column: 1,
    value,
    hasValue: value.length > 0,
    quoted: null,
    exported: false,
    references: [],
    duplicateOfLine: null,
    leadingComments: [],
    inlineComment: null,
    unquotedInlineComment: null,
    hasTrailingWhitespace: false,
    kind: init.kind ?? 'dev',
    shared: init.shared ?? false,
    devOnly: init.devOnly ?? false,
  };
};

interface UsageInit {
  readonly name: string;
  readonly file?: string;
  readonly line?: number;
  readonly fallbackLiteral?: string | null;
  readonly hasFallback?: boolean;
  readonly required?: boolean;
}

const makeUsage = (init: UsageInit): EnvUsage => ({
  name: init.name,
  file: init.file ?? 'src/config.ts',
  line: init.line ?? 1,
  column: 1,
  language: 'typescript',
  accessor: 'process.env',
  hasFallback: init.hasFallback ?? (init.fallbackLiteral !== undefined && init.fallbackLiteral !== null),
  required: init.required ?? false,
  viaImport: false,
  fallbackLiteral: init.fallbackLiteral ?? null,
});

interface FileInit {
  readonly path: string;
  readonly kind?: EnvFileKind;
  readonly committed?: boolean;
  readonly shared?: boolean;
  readonly devOnly?: boolean;
}

const makeFile = (init: FileInit): EnvFileInfo => ({
  path: init.path,
  kind: init.kind ?? 'dev',
  exists: true,
  shared: init.shared ?? false,
  devOnly: init.devOnly ?? false,
  tracked: init.committed ?? true,
  declCount: 1,
  issues: [],
  committed: init.committed ?? true,
  byteSize: 64,
});

interface ScenarioInit {
  readonly decls?: readonly EnvVarDecl[];
  readonly usages?: readonly EnvUsage[];
  readonly files?: readonly EnvFileInfo[];
  readonly config?: Partial<ResolvedConfig>;
  readonly suppress?: (location: SourceLocation, ruleId: RuleId) => boolean;
}

interface Scenario {
  readonly context: RuleContext;
  readonly findings: FindingInput[];
}

const makeContext = (init: ScenarioInit = {}): Scenario => {
  const findings: FindingInput[] = [];
  const decls = [...(init.decls ?? [])];
  const usages = [...(init.usages ?? [])];
  const byName = new Map<string, EnvVarDecl[]>();
  for (const decl of decls) {
    const bucket = byName.get(decl.name);
    if (bucket === undefined) {
      byName.set(decl.name, [decl]);
    } else {
      bucket.push(decl);
    }
  }
  const usagesByName = new Map<string, EnvUsage[]>();
  for (const usage of usages) {
    const bucket = usagesByName.get(usage.name);
    if (bucket === undefined) {
      usagesByName.set(usage.name, [usage]);
    } else {
      bucket.push(usage);
    }
  }
  const names = [...new Set([...decls.map((decl) => decl.name), ...usages.map((usage) => usage.name)])].sort();
  const context: RuleContext = {
    root: '/repo',
    config: baseConfig(init.config),
    decls,
    usages,
    infra: [],
    files: new Map((init.files ?? []).map((file) => [file.path, file])),
    manifest: null,
    byName,
    usagesByName,
    infraByName: new Map(),
    names,
    isSuppressed: init.suppress ?? (() => false),
    report: (finding: FindingInput): void => {
      findings.push(finding);
    },
  };
  return { context, findings };
};

const ruleById = (ruleId: RuleId): Rule => {
  const rule = securityRules.find((candidate) => candidate.id === ruleId);
  assert.ok(rule, `rule ${ruleId} must be exported from securityRules`);
  return rule;
};

const runRule = (ruleId: RuleId, init: ScenarioInit = {}): readonly FindingInput[] => {
  const scenario = makeContext(init);
  ruleById(ruleId).check(scenario.context);
  return scenario.findings;
};

const ruleIds = (): RuleId[] => securityRules.map((rule) => rule.id);

describe('securityRules table', () => {
  test('exports exactly the ten security rules, once each', () => {
    assert.deepEqual(ruleIds(), [
      'invalid-name',
      'reserved-name',
      'hostile-name',
      'shell-incompatible-name',
      'weak-secret',
      'secret-in-repo',
      'secret-in-example',
      'secret-fallback-literal',
      'debug-flag-shared-env',
      'hardcoded-connection-string',
    ]);
    assert.equal(new Set(ruleIds()).size, 10);
  });

  test('every rule carries a complete definition with a docs anchor', () => {
    for (const rule of securityRules) {
      assert.equal(rule.docs, `docs/rules.md#${rule.id}`, `${rule.id}: docs anchor`);
      assert.equal(rule.title.length > 0, true, `${rule.id}: title`);
      assert.equal(rule.description.length > 20, true, `${rule.id}: description`);
      assert.equal(rule.remediation.length > 10, true, `${rule.id}: remediation`);
      assert.equal(rule.tags.length > 0, true, `${rule.id}: tags`);
      assert.equal(['error', 'warn', 'info'].includes(rule.severity), true, `${rule.id}: severity`);
      assert.equal(typeof rule.check, 'function', `${rule.id}: check`);
    }
  });

  test('uses the severities and tags the documentation promises', () => {
    const expected: Readonly<Record<string, { severity: string; tags: readonly string[] }>> = {
      'invalid-name': { severity: 'warn', tags: ['hygiene'] },
      'reserved-name': { severity: 'warn', tags: ['correctness'] },
      'hostile-name': { severity: 'error', tags: ['security'] },
      'shell-incompatible-name': { severity: 'warn', tags: ['hygiene'] },
      'weak-secret': { severity: 'warn', tags: ['security'] },
      'secret-in-repo': { severity: 'error', tags: ['security'] },
      'secret-in-example': { severity: 'error', tags: ['security'] },
      'secret-fallback-literal': { severity: 'error', tags: ['security'] },
      'debug-flag-shared-env': { severity: 'warn', tags: ['security'] },
      'hardcoded-connection-string': { severity: 'error', tags: ['security'] },
    };
    for (const rule of securityRules) {
      const want = expected[rule.id];
      assert.ok(want, `${rule.id}: unexpected rule`);
      assert.equal(rule.severity, want.severity, `${rule.id}: severity`);
      assert.deepEqual([...rule.tags], [...want.tags], `${rule.id}: tags`);
    }
  });

  test('no rule ever throws, whatever the input looks like', () => {
    for (const rule of securityRules) {
      const scenario = makeContext({
        decls: [
          makeDecl({ name: '', file: '.env', value: 'x'.repeat(5000) }),
          makeDecl({ name: '\u0000\u0001', file: '.env', value: '' }),
          makeDecl({ name: 'A'.repeat(400), file: '.env.example', kind: 'example' }),
        ],
        usages: [makeUsage({ name: '\u00e9PORT', fallbackLiteral: 'postgres://a:bbbbbbbb@host/db' })],
        suppress: () => {
          throw new Error('suppression backend exploded');
        },
      });
      assert.doesNotThrow(() => {
        rule.check(scenario.context);
      }, `${rule.id} must not throw`);
    }
  });

  test('no rule backtracks on 100 KB adversarial values', () => {
    const seeds = [
      "aaaaa':://==",
      'a',
      'A',
      'AAAA',
      'a+.a',
      'a:@',
      'AccountKey=',
      'aA1bB2cC3dD4eE5fF6gG7hH8iI9jJ0kK1lL2mM3',
      'aA1bB2cC3dD4eE5fF6https://gG7hH8iI9jJ0kK1:Zz9yY8xX7wW6@vV5uU4tT3sS2rR1',
    ];
    const decls = seeds.map((seed, index) => {
      const value = seed.repeat(Math.ceil(102400 / seed.length)).slice(0, 102400);
      return makeDecl({
        name: `DATABASE_URL_${index}`,
        value,
        file: index % 2 === 0 ? '.env' : '.env.example',
        kind: index % 2 === 0 ? 'production' : 'example',
        line: index + 1,
        shared: true,
      });
    });
    const scenario = makeContext({ decls });
    const started = process.hrtime.bigint();
    for (const rule of securityRules) {
      rule.check(scenario.context);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(elapsedMs < 1000, true, `ten rules over ${decls.length} x 100 KB values took ${elapsedMs.toFixed(1)} ms`);
  });
});

describe('invalid-name', () => {
  test('fires on a name that is not an identifier and names the character', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: 'API.KEY', file: '.env' })] });
    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.ok(finding);
    assert.equal(finding.ruleId, 'invalid-name');
    assert.match(finding.message, /"API\.KEY"/);
    assert.match(finding.message, /it contains the character "\." \(U\+002E\)/);
    assert.equal(finding.location.line, 1);
    assert.equal(finding.variable, 'API.KEY');
  });

  test('fires on a leading digit', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: '1ST_KEY' })] });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /starts with the digit "1"/);
  });

  test('fires on a non-ASCII name', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: 'CAF\u00c9_TOKEN' })] });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /U\+00C9/);
  });

  test('fires on a valid identifier that is not UPPER_SNAKE_CASE', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: 'port' }), makeDecl({ name: 'ApiKey' })] });
    assert.equal(findings.length, 2);
    assert.match(findings[0]?.message ?? '', /"port" is a valid identifier but is not UPPER_SNAKE_CASE/);
    assert.equal(findings[0]?.hint, 'Rename it to "PORT".');
    assert.match(findings[1]?.message ?? '', /"ApiKey" is a valid identifier but is not UPPER_SNAKE_CASE/);
    assert.equal(findings[1]?.hint, 'Rename it to "API_KEY".');
  });

  test('suggests the snake case form of a mixed-case name', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: 'APIKey' })] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.hint, 'Rename it to "API_KEY".');
  });

  test('fires for a read that never has a declaration', () => {
    const findings = runRule('invalid-name', { usages: [makeUsage({ name: 'app.port' })] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.location.file, 'src/config.ts');
  });

  test('reports once per name and file, at the first declaration', () => {
    const findings = runRule('invalid-name', {
      decls: [
        makeDecl({ name: 'app.port', file: '.env', line: 7 }),
        makeDecl({ name: 'app.port', file: '.env', line: 3 }),
        makeDecl({ name: 'app.port', file: 'apps/api/.env', line: 2 }),
      ],
      usages: [makeUsage({ name: 'app.port', file: '.env' })],
    });
    assert.equal(findings.length, 2);
    assert.equal(findings[0]?.location.file, '.env');
    assert.equal(findings[0]?.location.line, 3);
  });

  test('reports a leading-underscore name with a usable suggestion', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: '_INTERNAL_URL' })] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.hint, 'Rename it to "INTERNAL_URL".');
  });

  test('does not fire for UPPER_SNAKE_CASE names', () => {
    const findings = runRule('invalid-name', { decls: [makeDecl({ name: 'PORT' }), makeDecl({ name: 'DATABASE_URL' })] });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreVariables, case insensitively', () => {
    const findings = runRule('invalid-name', {
      decls: [makeDecl({ name: 'API.KEY' }), makeDecl({ name: 'app.port' })],
      config: { ignoreVariables: ['api.*', 'APP.*'] },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('reserved-name', () => {
  test('fires for a reserved name declared in a shared file', () => {
    const findings = runRule('reserved-name', {
      decls: [makeDecl({ name: 'PATH', file: '.env', shared: true })],
      files: [makeFile({ path: '.env', shared: true })],
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /"PATH" is a reserved environment variable/);
    assert.match(findings[0]?.hint ?? '', /APP_PATH/);
  });

  test('fires for a lower-case spelling of a reserved name', () => {
    const findings = runRule('reserved-name', { decls: [makeDecl({ name: 'home' })] });
    assert.equal(findings.length, 1);
  });

  test('reads the effective list from the config, not from a hardcoded table', () => {
    const findings = runRule('reserved-name', {
      decls: [makeDecl({ name: 'TZ' }), makeDecl({ name: 'PATH' })],
      config: { reservedNames: new Set(['TZ']) },
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.variable, 'TZ');
  });

  test('does not fire for an application-scoped name', () => {
    const findings = runRule('reserved-name', { decls: [makeDecl({ name: 'APP_PATH' }), makeDecl({ name: 'TZ' })] });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreVariables', () => {
    const findings = runRule('reserved-name', {
      decls: [makeDecl({ name: 'PATH' })],
      config: { ignoreVariables: ['path'] },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('hostile-name', () => {
  test('is an error in a shared file and explains the code-execution risk', () => {
    const findings = runRule('hostile-name', {
      decls: [makeDecl({ name: 'LD_PRELOAD', file: '.env', shared: true })],
      files: [makeFile({ path: '.env', shared: true })],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'error');
    assert.equal(ruleById('hostile-name').severity, 'error');
    assert.match(findings[0]?.message ?? '', /"LD_PRELOAD" is a code-execution switch/);
  });

  test('is a warning in a developer-only file', () => {
    const findings = runRule('hostile-name', {
      decls: [makeDecl({ name: 'LD_PRELOAD', file: '.env.local', kind: 'local', devOnly: true })],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'warn');
  });

  test('is informational when the code only reads the variable', () => {
    const findings = runRule('hostile-name', {
      usages: [makeUsage({ name: 'NODE_OPTIONS', file: 'src/server.ts', line: 4 })],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'info');
    assert.match(findings[0]?.message ?? '', /never declared/);
    assert.equal(findings[0]?.location.line, 4);
  });

  test('does not double-report a read of a declared hostile name', () => {
    const findings = runRule('hostile-name', {
      decls: [makeDecl({ name: 'BASH_ENV', shared: true })],
      usages: [makeUsage({ name: 'BASH_ENV' })],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'error');
  });

  test('uses the generic message for a hostile name outside the loader family', () => {
    const findings = runRule('hostile-name', {
      decls: [makeDecl({ name: 'CORP_LOADER', shared: true })],
      config: { hostileNames: new Set(['CORP_LOADER']) },
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /"CORP_LOADER" is a hostile environment variable/);
  });

  test('does not fire for a name that is merely debug-ish', () => {
    const findings = runRule('hostile-name', {
      decls: [makeDecl({ name: 'NODE_ENV', shared: true }), makeDecl({ name: 'ENVIRONMENT', shared: true })],
    });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreVariables', () => {
    const findings = runRule('hostile-name', {
      decls: [makeDecl({ name: 'LD_PRELOAD', shared: true }), makeDecl({ name: 'PATH', shared: true })],
      config: { ignoreVariables: ['LD_*', 'PATH'] },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('shell-incompatible-name', () => {
  const longName = `A${'B'.repeat(200)}`;

  test('fires for a name that is too long', () => {
    const findings = runRule('shell-incompatible-name', { decls: [makeDecl({ name: longName })] });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /201 characters long \(limit 127\)/);
  });

  test('does not fire for a name that is not a valid identifier at all', () => {
    const findings = runRule('shell-incompatible-name', { decls: [makeDecl({ name: 'CAF\u00c9_TOKEN' })] });
    assert.deepEqual([...findings], []);
    assert.equal(runRule('invalid-name', { decls: [makeDecl({ name: 'CAF\u00c9_TOKEN' })] }).length, 1);
  });

  test('does not fire for a name of exactly 127 characters', () => {
    const findings = runRule('shell-incompatible-name', { decls: [makeDecl({ name: 'A'.repeat(127) })] });
    assert.deepEqual([...findings], []);
  });

  test('does not fire for an ordinary name', () => {
    const findings = runRule('shell-incompatible-name', { decls: [makeDecl({ name: 'DATABASE_URL' })] });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreVariables', () => {
    const findings = runRule('shell-incompatible-name', {
      decls: [makeDecl({ name: longName })],
      config: { ignoreVariables: ['A*'] },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('weak-secret', () => {
  test('fires for a value on the weak-value list without printing it', () => {
    const findings = runRule('weak-secret', { decls: [makeDecl({ name: 'ADMIN_PASSWORD', value: 'changeme' })] });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /"ADMIN_PASSWORD" in \.env is not a real credential/);
    assert.match(findings[0]?.message ?? '', /weak-value list/);
    assert.equal(findings[0]?.message.includes('changeme'), false);
    assert.equal(findings[0]?.fingerprint, fingerprint('changeme'));
  });

  test('fires for an empty secret', () => {
    const findings = runRule('weak-secret', { decls: [makeDecl({ name: 'API_KEY', value: '' })] });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /the value is empty/);
  });

  test('fires for a placeholder shape that is not on the list', () => {
    for (const value of ['your-api-key', '<your-token>', '${API_KEY}', 'xxxxxxxx', 'todo', 'replace-me']) {
      const findings = runRule('weak-secret', { decls: [makeDecl({ name: 'SERVICE_TOKEN', value })] });
      assert.equal(findings.length, 1, `${value} must be reported`);
    }
  });

  test('does not fire in example or template files', () => {
    const findings = runRule('weak-secret', {
      decls: [
        makeDecl({ name: 'API_KEY', value: 'changeme', file: '.env.example', kind: 'example' }),
        makeDecl({ name: 'API_KEY', value: '', file: '.env.template', kind: 'template' }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('does not fire for a real-looking value or a non-secret name', () => {
    const findings = runRule('weak-secret', {
      decls: [
        makeDecl({ name: 'API_KEY', value: AWS_EXAMPLE_SECRET }),
        makeDecl({ name: 'PORT', value: '3000' }),
        makeDecl({ name: 'FEATURE_FLAG', value: 'changeme' }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreVariables', () => {
    const findings = runRule('weak-secret', {
      decls: [makeDecl({ name: 'ADMIN_PASSWORD', value: 'changeme' })],
      config: { ignoreVariables: ['admin_*'] },
    });
    assert.deepEqual([...findings], []);
  });

  test('leaves the severity to the config when the rule has no per-instance opinion', () => {
    const findings = runRule('weak-secret', {
      decls: [makeDecl({ name: 'ADMIN_PASSWORD', value: 'changeme' })],
      config: { severities: { 'weak-secret': 'info' } },
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, undefined);
  });
});

describe('secret-in-repo', () => {
  const committed = (decls: readonly EnvVarDecl[]): ScenarioInit => ({
    decls,
    files: decls.map((decl) => makeFile({ path: decl.file, committed: true, shared: true, kind: decl.kind })),
  });

  test('is an error for a committed file and names the pattern and fingerprint only', () => {
    const findings = runRule('secret-in-repo', {
      decls: [makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, shared: true })],
      files: [makeFile({ path: '.env', committed: true, shared: true })],
    });
    assert.equal(findings.length, 1);
    const finding = findings[0];
    assert.ok(finding);
    assert.equal(finding.severity, 'error');
    assert.match(finding.message, /AWS access key id/);
    assert.equal(finding.message.includes(AWS_EXAMPLE_KEY_ID), false);
    assert.equal(finding.fingerprint, fingerprint(AWS_EXAMPLE_KEY_ID));
    assert.equal(finding.message.includes(fingerprint(AWS_EXAMPLE_KEY_ID)), true);
    assert.equal(finding.variable, 'AWS_ACCESS_KEY_ID');
  });

  test('downgrades to a warning for a file that is not committed', () => {
    const findings = runRule('secret-in-repo', {
      decls: [makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, file: '.env.local', kind: 'local', devOnly: true })],
      files: [makeFile({ path: '.env.local', kind: 'local', committed: false, devOnly: true })],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'warn');
    assert.match(findings[0]?.message ?? '', /not committed/);
  });

  test('treats a file missing from the report as committed', () => {
    const findings = runRule('secret-in-repo', {
      decls: [makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, file: 'unknown/.env' })],
    });
    assert.equal(findings[0]?.severity, 'error');
  });

  test('fires for a high-entropy secretish value with no pattern match', () => {
    const findings = runRule('secret-in-repo', committed([makeDecl({ name: 'AWS_SECRET_ACCESS_KEY', value: AWS_EXAMPLE_SECRET, shared: true })]));
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /machine-generated/);
    assert.equal(findings[0]?.message.includes(AWS_EXAMPLE_SECRET), false);
  });

  test('names every pattern that matched in a single finding', () => {
    const findings = runRule('secret-in-repo', committed([makeDecl({ name: 'MULTI', value: AWS_EXAMPLE_KEY_ID, shared: true })]));
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /1 known credential pattern/);
  });

  test('does not fire for ordinary values or for a placeholder that is only weak-secret material', () => {
    const findings = runRule('secret-in-repo', {
      decls: [
        makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, file: '.env.example', kind: 'example' }),
        makeDecl({ name: 'SHORT_TOKEN', value: 'abc', shared: true }),
        makeDecl({ name: 'GREETING', value: 'hello world', shared: true }),
        makeDecl({ name: 'API_KEY', value: 'your-api-key-here', shared: true }),
      ],
    });
    assert.deepEqual([...findings], []);
    assert.equal(
      runRule('weak-secret', { decls: [makeDecl({ name: 'API_KEY', value: 'your-api-key-here' })] }).length,
      1,
    );
  });

  test('respects ignoreFingerprints and ignoreVariables', () => {
    const decls = [makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, shared: true })];
    assert.deepEqual(
      [...runRule('secret-in-repo', { ...committed(decls), config: { ignoreFingerprints: new Set([fingerprint(AWS_EXAMPLE_KEY_ID)]) } })],
      [],
    );
    assert.deepEqual([...runRule('secret-in-repo', { ...committed(decls), config: { ignoreVariables: ['aws_*'] } })], []);
  });

  test('honours a configured secret pattern', () => {
    const findings = runRule('secret-in-repo', {
      ...committed([makeDecl({ name: 'ACME_TOKEN', value: 'acme_123456', shared: true })]),
      config: { secretPatterns: [{ id: 'acme', name: 'Acme token', pattern: 'acme_[0-9]{6}', test: 'acme_123456' }] },
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /Acme token/);
  });

  test('keeps the per-instance severity even when the config lowers the rule severity', () => {
    const findings = runRule('secret-in-repo', {
      decls: [makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, shared: true })],
      files: [makeFile({ path: '.env', committed: true, shared: true })],
      config: { severities: { 'secret-in-repo': 'info' } },
    });
    assert.equal(findings[0]?.severity, 'error');
  });
});

describe('secret-in-example', () => {
  test('fires for a real credential pasted into .env.example', () => {
    const findings = runRule('secret-in-example', {
      decls: [makeDecl({ name: 'STRIPE_SECRET_KEY', value: STRIPE_EXAMPLE_TEST_KEY, file: '.env.example', kind: 'example' })],
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, undefined);
    assert.match(findings[0]?.message ?? '', /Example file \.env\.example/);
    assert.match(findings[0]?.message ?? '', /Stripe test key/);
    assert.equal(findings[0]?.message.includes(STRIPE_EXAMPLE_TEST_KEY), false);
    assert.equal(findings[0]?.fingerprint, fingerprint(STRIPE_EXAMPLE_TEST_KEY));
  });

  test('does not fire for a documented placeholder password in a template', () => {
    const findings = runRule('secret-in-example', {
      decls: [
        makeDecl({ name: 'DATABASE_URL', value: CONNECTION_PLACEHOLDER, file: '.env.example', kind: 'example' }),
        makeDecl({ name: 'API_KEY', value: 'your-api-key-here', file: '.env.example', kind: 'example' }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('does not fire outside example and template files', () => {
    const findings = runRule('secret-in-example', {
      decls: [makeDecl({ name: 'STRIPE_SECRET_KEY', value: STRIPE_EXAMPLE_TEST_KEY, file: '.env', kind: 'production' })],
    });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreFingerprints and ignoreVariables', () => {
    const decls = [makeDecl({ name: 'STRIPE_SECRET_KEY', value: STRIPE_EXAMPLE_TEST_KEY, file: '.env.example', kind: 'example' })];
    assert.deepEqual(
      [...runRule('secret-in-example', { decls, config: { ignoreFingerprints: new Set([fingerprint(STRIPE_EXAMPLE_TEST_KEY)]) } })],
      [],
    );
    assert.deepEqual([...runRule('secret-in-example', { decls, config: { ignoreVariables: ['STRIPE_*'] } })], []);
  });
});

describe('secret-fallback-literal', () => {
  test('fires for a hardcoded secret fallback in source code', () => {
    const findings = runRule('secret-fallback-literal', {
      usages: [makeUsage({ name: 'GITHUB_TOKEN', file: 'src/ci.ts', line: 12, fallbackLiteral: GITHUB_EXAMPLE_TOKEN })],
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /Code reads "GITHUB_TOKEN" in src\/ci\.ts with a hardcoded fallback literal/);
    assert.equal(findings[0]?.message.includes(GITHUB_EXAMPLE_TOKEN), false);
    assert.equal(findings[0]?.fingerprint, fingerprint(GITHUB_EXAMPLE_TOKEN));
    assert.equal(findings[0]?.location.line, 12);
  });

  test('does not fire for a non-secret fallback or no fallback at all', () => {
    const findings = runRule('secret-fallback-literal', {
      usages: [
        makeUsage({ name: 'PORT', fallbackLiteral: '3000' }),
        makeUsage({ name: 'APP_ENV', fallbackLiteral: 'production' }),
        makeUsage({ name: 'API_KEY' }),
        makeUsage({ name: 'API_KEY', fallbackLiteral: 'changeme' }),
        makeUsage({ name: 'API_KEY', fallbackLiteral: '' }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreFingerprints', () => {
    const findings = runRule('secret-fallback-literal', {
      usages: [makeUsage({ name: 'GITHUB_TOKEN', fallbackLiteral: GITHUB_EXAMPLE_TOKEN })],
      config: { ignoreFingerprints: new Set([fingerprint(GITHUB_EXAMPLE_TOKEN)]) },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('debug-flag-shared-env', () => {
  test('fires for a debug switch in a shared file', () => {
    const findings = runRule('debug-flag-shared-env', {
      decls: [makeDecl({ name: 'DEBUG', value: 'true', file: '.env', kind: 'production', shared: true })],
      files: [makeFile({ path: '.env', kind: 'production', shared: true })],
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /Shared env file \.env sets "DEBUG"="true"/);
    assert.match(findings[0]?.hint ?? '', /ENABLE_DEBUG/);
  });

  test('fires for an auth bypass flag in a shared file', () => {
    const findings = runRule('debug-flag-shared-env', {
      decls: [makeDecl({ name: 'DISABLE_AUTH', value: 'yes', kind: 'production', shared: true })],
    });
    assert.equal(findings.length, 1);
  });

  test('does not fire for a quiet log level or a false switch', () => {
    const findings = runRule('debug-flag-shared-env', {
      decls: [
        makeDecl({ name: 'LOG_LEVEL', value: 'info', kind: 'production', shared: true }),
        makeDecl({ name: 'LOG_LEVEL', value: 'warn', kind: 'production', shared: true }),
        makeDecl({ name: 'DEBUG', value: 'false', kind: 'production', shared: true }),
        makeDecl({ name: 'DEBUG', value: '', kind: 'production', shared: true }),
        makeDecl({ name: 'CACHE_TTL', value: 'true', kind: 'production', shared: true }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('does not fire for local, test, example or unshared files', () => {
    const findings = runRule('debug-flag-shared-env', {
      decls: [
        makeDecl({ name: 'DEBUG', value: 'true', file: '.env.local', kind: 'local' }),
        makeDecl({ name: 'DEBUG', value: 'true', file: '.env.test', kind: 'test' }),
        makeDecl({ name: 'DEBUG', value: 'true', file: '.env.example', kind: 'example' }),
        makeDecl({ name: 'DEBUG', value: 'true', file: '.env', kind: 'dev' }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('respects ignoreVariables', () => {
    const findings = runRule('debug-flag-shared-env', {
      decls: [makeDecl({ name: 'DEBUG', value: 'true', kind: 'production', shared: true })],
      config: { ignoreVariables: ['debug'] },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('hardcoded-connection-string', () => {
  test('fires for a real password embedded in an example file', () => {
    const findings = runRule('hardcoded-connection-string', {
      decls: [makeDecl({ name: 'DATABASE_URL', value: CONNECTION_WITH_PASSWORD, file: '.env.example', kind: 'example' })],
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /Example file \.env\.example embeds a plaintext password/);
    assert.equal(findings[0]?.message.includes('PLACEHOLDER_PASSWORD_1'), false);
    assert.equal(findings[0]?.fingerprint, fingerprint(CONNECTION_WITH_PASSWORD));
  });

  test('fires for a non-secretish variable name in a loaded file', () => {
    const findings = runRule('hardcoded-connection-string', {
      decls: [makeDecl({ name: 'BACKEND_ENDPOINT', value: 'https://svc:Sup3rSecretValue@example.com/api', file: '.env' })],
    });
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /Connection string for "BACKEND_ENDPOINT"/);
    assert.equal(findings[0]?.message.includes('Sup3rSecretValue'), false);
  });

  test('leaves the secretish case in a loaded file to secret-in-repo', () => {
    const decls = [makeDecl({ name: 'DATABASE_URL', value: CONNECTION_WITH_PASSWORD, file: '.env' })];
    assert.deepEqual([...runRule('hardcoded-connection-string', { decls })], []);
    assert.equal(runRule('secret-in-repo', { decls }).length, 1);
  });

  test('does not fire for a placeholder password or a short one', () => {
    const findings = runRule('hardcoded-connection-string', {
      decls: [
        makeDecl({ name: 'DATABASE_URL', value: CONNECTION_PLACEHOLDER, file: '.env.example', kind: 'example' }),
        makeDecl({ name: 'DATABASE_URL', value: 'postgres://appuser:pass@db.internal:5432/appdb', file: '.env.example', kind: 'example' }),
        makeDecl({ name: 'DATABASE_URL', value: 'postgres://db.internal:5432/appdb', file: '.env.example', kind: 'example' }),
      ],
    });
    assert.deepEqual([...findings], []);
  });

  test('finds the password in a value that holds more than one URL', () => {
    const findings = runRule('hardcoded-connection-string', {
      decls: [
        makeDecl({
          name: 'CACHE_AND_DATABASE',
          value: 'redis://cache.internal:6379,postgres://appuser:PLACEHOLDER_PASSWORD_1@db.internal:5432/appdb',
          file: '.env.example',
          kind: 'example',
        }),
      ],
    });
    assert.equal(findings.length, 1);
  });

  test('respects ignoreFingerprints', () => {
    const findings = runRule('hardcoded-connection-string', {
      decls: [makeDecl({ name: 'DATABASE_URL', value: CONNECTION_WITH_PASSWORD, file: '.env.example', kind: 'example' })],
      config: { ignoreFingerprints: new Set([fingerprint(CONNECTION_WITH_PASSWORD)]) },
    });
    assert.deepEqual([...findings], []);
  });
});

describe('suppression', () => {
  const firingScenarios: Readonly<Record<string, ScenarioInit>> = {
    'invalid-name': { decls: [makeDecl({ name: 'API.KEY' })] },
    'reserved-name': { decls: [makeDecl({ name: 'PATH' })] },
    'hostile-name': { decls: [makeDecl({ name: 'LD_PRELOAD', shared: true })] },
    'shell-incompatible-name': { decls: [makeDecl({ name: `A${'B'.repeat(200)}` })] },
    'weak-secret': { decls: [makeDecl({ name: 'API_KEY', value: 'changeme' })] },
    'secret-in-repo': {
      decls: [makeDecl({ name: 'AWS_ACCESS_KEY_ID', value: AWS_EXAMPLE_KEY_ID, shared: true })],
      files: [makeFile({ path: '.env', committed: true, shared: true })],
    },
    'secret-in-example': {
      decls: [makeDecl({ name: 'STRIPE_SECRET_KEY', value: STRIPE_EXAMPLE_TEST_KEY, file: '.env.example', kind: 'example' })],
    },
    'secret-fallback-literal': { usages: [makeUsage({ name: 'GITHUB_TOKEN', fallbackLiteral: GITHUB_EXAMPLE_TOKEN })] },
    'debug-flag-shared-env': { decls: [makeDecl({ name: 'DEBUG', value: 'true', kind: 'production', shared: true })] },
    'hardcoded-connection-string': {
      decls: [makeDecl({ name: 'DATABASE_URL', value: CONNECTION_WITH_PASSWORD, file: '.env.example', kind: 'example' })],
    },
  };

  for (const rule of securityRules) {
    test(`${rule.id} reports without suppression and stays silent with it`, () => {
      const scenario = firingScenarios[rule.id];
      assert.ok(scenario, `${rule.id} needs a firing scenario`);
      const reported = runRule(rule.id, scenario);
      assert.equal(reported.length > 0, true, `${rule.id} must fire on its scenario`);
      const suppressed = runRule(rule.id, { ...scenario, suppress: () => true });
      assert.deepEqual([...suppressed], [], `${rule.id} must honour isSuppressed`);
      const asked: RuleId[] = [];
      const recorded = runRule(rule.id, {
        ...scenario,
        suppress: (_location, ruleId) => {
          asked.push(ruleId);
          return false;
        },
      });
      assert.equal(recorded.length > 0, true, `${rule.id} must fire again`);
      assert.deepEqual([...new Set(asked)], [rule.id], `${rule.id} must ask only about its own rule id`);
    });
  }
});

describe('secret hygiene', () => {
  const KITCHEN_SINK: ScenarioInit = {
    decls: [
      makeDecl({ name: 'API.KEY', file: '.env', value: AWS_EXAMPLE_KEY_ID, shared: true }),
      makeDecl({ name: 'AWS_ACCESS_KEY_ID', file: '.env', line: 2, value: AWS_EXAMPLE_KEY_ID, shared: true }),
      makeDecl({ name: 'AWS_SECRET_ACCESS_KEY', file: '.env', line: 3, value: AWS_EXAMPLE_SECRET, shared: true }),
      makeDecl({ name: 'DATABASE_URL', file: '.env', line: 4, value: CONNECTION_WITH_PASSWORD, shared: true }),
      makeDecl({ name: 'ADMIN_PASSWORD', file: '.env', line: 5, value: 'changeme' }),
      makeDecl({ name: 'GITHUB_TOKEN', file: '.env.local', line: 6, value: GITHUB_EXAMPLE_TOKEN, kind: 'local', devOnly: true }),
      makeDecl({ name: 'STRIPE_SECRET_KEY', file: '.env.example', line: 7, value: STRIPE_EXAMPLE_TEST_KEY, kind: 'example' }),
      makeDecl({ name: 'BACKEND_ENDPOINT', file: '.env.example', line: 8, value: 'https://svc:Sup3rSecretValue@example.com/api', kind: 'example' }),
      makeDecl({ name: 'LD_PRELOAD', file: '.env', line: 9, value: '/tmp/evil.so', shared: true }),
      makeDecl({ name: 'PATH', file: '.env', line: 10, value: '/tmp:$PATH', shared: true }),
      makeDecl({ name: 'DEBUG', file: '.env', line: 11, value: 'true', kind: 'production', shared: true }),
      makeDecl({ name: `A${'B'.repeat(200)}`, file: '.env', line: 12, value: 'x' }),
    ],
    usages: [
      makeUsage({ name: 'GITHUB_TOKEN', file: 'src/ci.ts', line: 3, fallbackLiteral: GITHUB_EXAMPLE_TOKEN }),
      makeUsage({ name: 'NODE_OPTIONS', file: 'src/server.ts', line: 9 }),
    ],
    files: [
      makeFile({ path: '.env', kind: 'production', shared: true, committed: true }),
      makeFile({ path: '.env.local', kind: 'local', committed: false, devOnly: true }),
      makeFile({ path: '.env.example', kind: 'example', committed: true }),
    ],
  };

  const RAW_VALUES = [
    AWS_EXAMPLE_KEY_ID,
    AWS_EXAMPLE_SECRET,
    CONNECTION_WITH_PASSWORD,
    'changeme',
    GITHUB_EXAMPLE_TOKEN,
    STRIPE_EXAMPLE_TEST_KEY,
    'Sup3rSecretValue',
    '/tmp/evil.so',
  ];

  const allFindings = (): FindingInput[] => {
    const scenario = makeContext(KITCHEN_SINK);
    for (const rule of securityRules) {
      rule.check(scenario.context);
    }
    return scenario.findings;
  };

  test('every rule fires somewhere in the kitchen-sink report', () => {
    const fired = new Set(allFindings().map((finding) => finding.ruleId));
    for (const rule of securityRules) {
      assert.equal(fired.has(rule.id), true, `${rule.id} never fired`);
    }
  });

  test('no raw secret value ever reaches a message, a hint or a variable name', () => {
    const findings = allFindings();
    assert.equal(findings.length > 0, true);
    for (const finding of findings) {
      for (const secret of RAW_VALUES) {
        assert.equal(
          `${finding.message}${finding.hint ?? ''}${finding.variable ?? ''}`.includes(secret),
          false,
          `${finding.ruleId} leaked ${secret}`,
        );
      }
    }
  });

  test('no raw secret value ever reaches a rule fingerprint field', () => {
    for (const finding of allFindings()) {
      assert.equal(finding.fingerprint === undefined || /^[0-9a-f]{12}$/.test(finding.fingerprint), true, finding.ruleId);
    }
  });

  test('the value-bearing rules always attach a fingerprint', () => {
    const fingerprinted = new Set([
      'weak-secret',
      'secret-in-repo',
      'secret-in-example',
      'secret-fallback-literal',
      'hardcoded-connection-string',
    ]);
    for (const finding of allFindings()) {
      if (!fingerprinted.has(finding.ruleId)) {
        continue;
      }
      assert.match(finding.fingerprint ?? '', /^[0-9a-f]{12}$/, `${finding.ruleId} needs a fingerprint`);
    }
  });

  test('the fingerprint of a finding is the fingerprint of the value it describes', () => {
    const findings = allFindings();
    const aws = findings.find((finding) => finding.ruleId === 'secret-in-repo' && finding.variable === 'AWS_ACCESS_KEY_ID');
    assert.equal(aws?.fingerprint, fingerprint(AWS_EXAMPLE_KEY_ID));
    const weak = findings.find((finding) => finding.ruleId === 'weak-secret');
    assert.equal(weak?.fingerprint, fingerprint('changeme'));
  });

  test('the report is deterministic for the same input', () => {
    const first = allFindings();
    const second = allFindings();
    assert.deepEqual(first, second);
  });
});
