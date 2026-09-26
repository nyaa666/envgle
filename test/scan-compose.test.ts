import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isComposeFile, scanCompose } from '../src/scan/compose.js';
import { parseYaml } from '../src/scan/yaml.js';
import { lineText } from '../src/utils/text.js';
import type { InfraRef } from '../src/types.js';
import type { ComposeScanOptions } from '../src/scan/compose.js';

const PATH = 'deploy/docker-compose.yml';
const OPTIONS: ComposeScanOptions = { envFileNames: ['.env', 'secrets'], isOverride: false };

type Tuple = readonly [name: string, line: number, column: number, kind: InfraRef['kind'], required: boolean];

interface Case {
  readonly title: string;
  readonly source: string;
  readonly expected: readonly Tuple[];
  readonly services?: readonly string[];
}

const tuples = (refs: readonly InfraRef[]): Tuple[] =>
  refs.map((ref) => [ref.name, ref.line, ref.column, ref.kind, ref.required]);

const scan = (source: string, path: string = PATH, options: ComposeScanOptions = OPTIONS) =>
  scanCompose(path, parseYaml(source), options);

const runCases = (cases: readonly Case[]): void => {
  for (const testCase of cases) {
    const result = scan(testCase.source);
    assert.deepEqual(tuples(result.refs), testCase.expected, testCase.title);
    if (testCase.services !== undefined) {
      assert.deepEqual(result.serviceNames, testCase.services, `${testCase.title} service names`);
    }
    for (const ref of result.refs) {
      assert.equal(ref.file, PATH, `${testCase.title} file`);
      assert.equal(typeof ref.name, 'string', `${testCase.title} name`);
    }
  }
};

test('isComposeFile matches the compose file names and nothing else', () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ['compose.yml', true],
    ['compose.yaml', true],
    ['docker-compose.yml', true],
    ['docker-compose.yaml', true],
    ['docker-compose.override.yml', true],
    ['docker-compose.override.yaml', true],
    ['compose.override.yml', true],
    ['COMPOSE.YML', true],
    ['Docker-Compose.YAML', true],
    ['compose.prod.yml', true],
    ['compose.local-dev.yml', true],
    ['docker-compose.prod-1.yaml', true],
    ['deploy/docker-compose.yml', true],
    ['deploy/nested/dir/compose.yaml', true],
    ['deploy\\docker-compose.yml', true],
    ['docker-compose', false],
    ['docker-compose.', false],
    ['docker-compose.override', false],
    ['docker-compose.yml.bak', false],
    ['compose.override.yml.txt', false],
    ['compose..yml', false],
    ['my-compose.yml', false],
    ['compose-test.yml', false],
    ['dockercompose.yml', false],
    ['not-a-compose.yml', false],
    ['composefile.yml', false],
    ['.env.compose.yml', false],
    ['compose/.yml', false],
    ['compose.yml/', false],
    ['', false],
    ['.yml', false],
  ];
  for (const [path, expected] of cases) {
    assert.equal(isComposeFile(path), expected, path);
  }
});

test('scanCompose reads the environment map form', () => {
  runCases([
    {
      title: 'map entries with and without a value',
      source: ['services:', '  web:', '    environment:', '      PORT: 3000', '      DEBUG:', "      MODE: 'prod' # pinned", '  api:', '    environment:', '      - ONLY_LIST'].join('\n'),
      services: ['web', 'api'],
      expected: [
        ['PORT', 4, 7, 'compose-environment', false],
        ['DEBUG', 5, 7, 'compose-environment', true],
        ['MODE', 6, 7, 'compose-environment', false],
        ['ONLY_LIST', 9, 9, 'compose-environment', true],
      ],
    },
    {
      title: 'comments and blank lines inside the block are skipped',
      source: ['services:', '  web:', '    environment:', '', '      # a note', '      A: 1', '', '      B: 2'].join('\n'),
      expected: [
        ['A', 6, 7, 'compose-environment', false],
        ['B', 8, 7, 'compose-environment', false],
      ],
    },
    {
      title: 'keys that are not variable names are skipped',
      source: ['services:', '  web:', '    environment:', '      - 1BAD=2', '      - not a name=', '      - "quoted=1"', '      - ok=1'].join('\n'),
      expected: [
        ['quoted', 6, 9, 'compose-environment', false],
        ['ok', 7, 9, 'compose-environment', false],
      ],
    },
  ]);
});

test('scanCompose reads the environment list form and the interpolations in it', () => {
  runCases([
    {
      title: 'list entries with, without and before a value',
      source: ['services:', '  web:', '    environment:', '      - PORT=3000', '      - DEBUG', '      - TOKEN=${SECRET}', '      -'].join('\n'),
      expected: [
        ['PORT', 4, 9, 'compose-environment', false],
        ['DEBUG', 5, 9, 'compose-environment', true],
        ['TOKEN', 6, 9, 'compose-environment', false],
        ['SECRET', 6, 15, 'compose-interpolation', false],
      ],
    },
    {
      title: 'a bare ${ and an unterminated ${VAR keep the key but report no interpolation',
      source: ['services:', '  web:', '    environment:', '      - A=${', '      - B=${NEVER_CLOSED', '      - C=1'].join('\n'),
      expected: [
        ['A', 4, 9, 'compose-environment', false],
        ['B', 5, 9, 'compose-environment', false],
        ['C', 6, 9, 'compose-environment', false],
      ],
    },
  ]);
});

test('scanCompose reads env_file in list, quoted, subdirectory, long and string form', () => {
  runCases([
    {
      title: 'list form with a comma separated pair and a quoted path',
      source: ['services:', '  web:', '    env_file:', '      - .env', '      - .env.local, .env.prod', '      - "config/.env"'].join('\n'),
      expected: [
        ['.env', 4, 9, 'compose-env-file', true],
        ['.env.local', 5, 9, 'compose-env-file', true],
        ['.env.prod', 5, 21, 'compose-env-file', true],
        ['config/.env', 6, 9, 'compose-env-file', true],
      ],
    },
    {
      title: 'string form and long form',
      source: ['services:', '  web:', '    env_file: .env, .env.global', '  api:', '    env_file:', '      - path: .env.ci', '        required: false'].join('\n'),
      services: ['web', 'api'],
      expected: [
        ['.env', 3, 15, 'compose-env-file', true],
        ['.env.global', 3, 21, 'compose-env-file', true],
        ['.env.ci', 6, 15, 'compose-env-file', true],
      ],
    },
  ]);
});

test('scanCompose reads build args in map and list form', () => {
  runCases([
    {
      title: 'args map and list under a build block',
      source: [
        'services:',
        '  web:',
        '    build:',
        '      context: .',
        '      args:',
        '        NODE_ENV: production',
        '        BARE:',
        '        - NPM_TOKEN=${NPM}',
        '        - BUILDER_FLAG',
        '        - PLAIN=1',
      ].join('\n'),
      expected: [
        ['NODE_ENV', 6, 9, 'compose-build-arg', false],
        ['BARE', 7, 9, 'compose-build-arg', true],
        ['NPM_TOKEN', 8, 11, 'compose-build-arg', false],
        ['NPM', 8, 21, 'compose-interpolation', false],
        ['BUILDER_FLAG', 9, 11, 'compose-build-arg', true],
        ['PLAIN', 10, 11, 'compose-build-arg', false],
      ],
    },
    {
      title: 'a build given as a string has no args',
      source: ['services:', '  web:', '    build: ./app', '    environment:', '      A: 1'].join('\n'),
      expected: [['A', 5, 7, 'compose-environment', false]],
    },
    {
      title: 'arg names that are not variable names are skipped',
      source: ['services:', '  web:', '    build:', '      args:', '        1BAD: 1', '        - 2BAD=2', '        - GOOD=3'].join('\n'),
      expected: [['GOOD', 7, 11, 'compose-build-arg', false]],
    },
  ]);
});

test('scanCompose reads the top level env_file and env keys', () => {
  runCases([
    {
      title: 'both top level keys next to the services block',
      source: ['env_file:', '  - .env', '  - .env.shared', 'env:', '  TOP: 1', '  - LIST=2', '  - BARE', 'services:', '  web:', '    image: nginx'].join('\n'),
      services: ['web'],
      expected: [
        ['.env', 2, 5, 'compose-env-file', true],
        ['.env.shared', 3, 5, 'compose-env-file', true],
        ['TOP', 5, 3, 'compose-environment', false],
        ['LIST', 6, 5, 'compose-environment', false],
        ['BARE', 7, 5, 'compose-environment', true],
      ],
    },
  ]);
});

test('scanCompose reports the services in declaration order and skips x- extension keys', () => {
  const source = [
    'services:',
    '  web:',
    '    environment:',
    '      WEB: 1',
    '  x-shared: &shared',
    '    environment:',
    '      NOT_A_SERVICE: 1',
    '  worker:',
    '    x-extra:',
    '      environment:',
    '        ALSO_NOT: 1',
    '  api:',
    '    environment:',
    '      API: 1',
    '',
  ].join('\n');
  const result = scan(source);
  assert.deepEqual(result.serviceNames, ['web', 'worker', 'api']);
  assert.deepEqual(
    result.refs.filter((ref) => ref.kind === 'compose-environment').map((ref) => ref.name),
    ['WEB', 'API'],
  );
});

test('scanCompose reports one interpolation per occurrence and never twice', () => {
  const source = [
    'services:',
    '  web:',
    '    ports:',
    '      - "${PORT}:3000"',
    '    environment:',
    '      - ADDR=localhost:${PORT}',
    '      - PLAIN=$PORT',
    '    labels:',
    '      - "port=${PORT}" # documented',
    '',
  ].join('\n');
  const result = scan(source);
  const ports = result.refs.filter((ref) => ref.name === 'PORT');
  assert.deepEqual(tuples(ports), [
    ['PORT', 4, 10, 'compose-interpolation', false],
    ['PORT', 6, 24, 'compose-interpolation', false],
    ['PORT', 7, 15, 'compose-interpolation', false],
    ['PORT', 9, 15, 'compose-interpolation', false],
  ]);
  assert.deepEqual(tuples(result.refs), [
    ['PORT', 4, 10, 'compose-interpolation', false],
    ['ADDR', 6, 9, 'compose-environment', false],
    ['PORT', 6, 24, 'compose-interpolation', false],
    ['PLAIN', 7, 9, 'compose-environment', false],
    ['PORT', 7, 15, 'compose-interpolation', false],
    ['PORT', 9, 15, 'compose-interpolation', false],
  ]);
  assert.equal(new Set(result.refs.map((ref) => `${ref.line}:${ref.column}:${ref.name}`)).size, result.refs.length);
});

test('scanCompose reports the interpolation forms and skips the non interpolations', () => {
  const source = [
    'services:',
    '  web:',
    '    image: ghcr.io/acme/api:${IMAGE_TAG:?tag is required}',
    '    environment:',
    '      - A=${A:-default}',
    '      - B=${B-default}',
    '      - C=${C:?message}',
    '      - D=${D?message}',
    '      - E=${E:prefix}',
    '      - F=${F/pattern/replacement}',
    '      - G=${G}',
    '      - H=$H',
    '      - I=$${LITERAL}',
    '      - J=$(echo hi)',
    '      - K=$((1 + 1))',
    '      - L=$9INVALID',
    '',
  ].join('\n');
  const result = scan(source);
  assert.deepEqual(
    result.refs.filter((ref) => ref.kind === 'compose-interpolation').map((ref) => [ref.name, ref.line, ref.column, ref.required]),
    [
      ['IMAGE_TAG', 3, 29, true],
      ['A', 5, 11, false],
      ['B', 6, 11, false],
      ['C', 7, 11, true],
      ['D', 8, 11, true],
      ['E', 9, 11, false],
      ['F', 10, 11, false],
      ['G', 11, 11, false],
      ['H', 12, 11, false],
    ],
  );
  for (const ref of result.refs) {
    assert.equal(ref.interpolation, ref.kind === 'compose-interpolation', `${ref.name}`);
    assert.equal(ref.refersToFile, false, `${ref.name}`);
  }
});

test('scanCompose reports nothing for shapes it cannot read', () => {
  runCases([
    { title: 'no services block at all', source: ['version: "3.9"', 'volumes:', '  data:', 'networks:', '  default:', '    name: ${NETWORK_NAME}'].join('\n'), expected: [['NETWORK_NAME', 6, 11, 'compose-interpolation', false]] },
    { title: 'services as a list instead of a map', source: ['services:', '  - web', '  - api', '    environment:', '      - NOPE=1'].join('\n'), services: [], expected: [] },
    { title: 'environment as a flow list', source: ['services:', '  web:', '    environment: [A=1, B=2]', '    image: ${TAG}'].join('\n'), services: ['web'], expected: [['TAG', 4, 12, 'compose-interpolation', false]] },
    { title: 'tab indented yaml', source: 'services:\n\tweb:\n\t\tenvironment:\n\t\t\t- A=1\n\t\t\t- B=${B}\n', services: [], expected: [['B', 5, 8, 'compose-interpolation', false]] },
    { title: 'mixed indentation', source: ['services:', '  web:', '   environment:', '     - A=1', '     - B=2'].join('\n'), services: ['web'], expected: [['A', 4, 8, 'compose-environment', false], ['B', 5, 8, 'compose-environment', false]] },
    { title: 'an unbalanced quote does not swallow the rest of the file', source: ['services:', '  web:', '    environment:', '      - A=1  # it\'s "broken', '      - B="unterminated', '      - C=3'].join('\n'), services: ['web'], expected: [['A', 4, 9, 'compose-environment', false], ['B', 5, 9, 'compose-environment', false], ['C', 6, 9, 'compose-environment', false]] },
    { title: 'an env_file list item that is a mapping is not a path', source: ['services:', '  web:', '    env_file:', '      - path:', '        required: true', '      - unknown: .env', '      - .env'].join('\n'), services: ['web'], expected: [['.env', 7, 9, 'compose-env-file', true]] },
    { title: 'a nested mapping under environment is not a variable', source: ['services:', '  web:', '    environment:', '      NODE_OPTIONS:', '        max: 1', '      A: 1'].join('\n'), services: ['web'], expected: [['NODE_OPTIONS', 4, 7, 'compose-environment', true], ['A', 6, 7, 'compose-environment', false]] },
    { title: 'an environment key that is not a variable name is skipped', source: ['services:', '  web:', '    environment:', '      1BAD: 1', '      ok: 1'].join('\n'), services: ['web'], expected: [['ok', 5, 7, 'compose-environment', false]] },
  ]);
});

test('scanCompose never throws on truncated or garbage input', () => {
  const sources = [
    '',
    '   ',
    'services:',
    'services:\n  web:\n    environment:\n      - A=',
    'services:\n  web:\n    env_file:\n      - ',
    'services:\n  web:\n    build:\n      args:',
    '\u0000\u0001 not: [valid\n---\n\t- }{ : ,,,\n  \u007f\n',
    'services:\n  web:\n    environment:\n      - ${A:-${B}\n      - ${',
    'env_file:',
    'services: []',
    'services: {web: {environment: {A: 1}}}',
    'services:\n  web:\n    environment:\n'.repeat(200),
  ];
  for (const source of sources) {
    assert.doesNotThrow(() => scan(source), JSON.stringify(source.slice(0, 60)));
    for (const ref of scan(source).refs) {
      assert.equal(typeof ref.name, 'string');
      assert.equal(ref.name.includes('undefined'), false, ref.name);
      assert.ok(ref.line >= 1, `${ref.name} line ${ref.line}`);
      assert.ok(ref.column >= 1, `${ref.name} column ${ref.column}`);
    }
  }
});

test('scanCompose exposes the compose file name and the override flag', () => {
  const source = 'services:\n  web:\n    image: nginx\n';
  assert.deepEqual(
    { name: scan(source).composeFileName, override: scan(source).isOverride },
    { name: 'docker-compose.yml', override: false },
  );
  const override = scan(source, 'deploy/docker-compose.override.yml');
  assert.deepEqual({ name: override.composeFileName, override: override.isOverride }, { name: 'docker-compose.override.yml', override: true });
  const forced = scan(source, 'docker-compose.yml', { envFileNames: [], isOverride: true });
  assert.equal(forced.isOverride, true);
  assert.equal(scan(source, 'compose.prod.yaml').isOverride, false);
});

test('scanCompose separates the referenced env files from the other references', () => {
  const source = [
    'services:',
    '  web:',
    '    env_file:',
    '      - .env',
    '      - config/.env',
    '      - config/settings.txt',
    '      - secrets',
    '      - .',
    'env_file: .env',
    '',
  ].join('\n');
  const result = scan(source, PATH, { envFileNames: ['.env', 'secrets'], isOverride: false });
  assert.deepEqual(result.referencedEnvFiles.map((ref) => ref.name), ['.env', 'config/.env', 'secrets', '.env']);
  assert.deepEqual(
    result.refs.filter((ref) => ref.refersToFile).map((ref) => ref.name),
    ['.env', 'config/.env', 'config/settings.txt', 'secrets', '.', '.env'],
    'every entry stays in refs with refersToFile',
  );
  for (const ref of result.referencedEnvFiles) {
    assert.equal(ref.kind, 'compose-env-file');
    assert.equal(ref.required, true);
  }
});

test('scanCompose points at the name inside the source line', () => {
  const source = [
    'services:',
    '  web:',
    '    image: ghcr.io/acme/api:${IMAGE_TAG} # pinned',
    '    environment:',
    '      - ADDR=localhost:${PORT}',
    '    env_file:',
    '      - .env, .env.prod',
    '',
  ].join('\n');
  const result = scan(source);
  assert.equal(result.refs.length, 5);
  for (const ref of result.refs) {
    const raw = lineText(source, ref.line);
    const rest = raw.slice(ref.column - 1);
    const expected = ref.kind === 'compose-interpolation' ? `\${${ref.name}` : ref.name;
    assert.equal(rest.startsWith(expected), true, `line ${ref.line} column ${ref.column} of ${JSON.stringify(raw)}`);
  }
});

test('scanCompose reads the same document through a bom, crlf and a document marker', () => {
  const plain = ['services:', '  web:', '    environment:', '      - A=1', '      - B=${B}'].join('\n');
  const decorated = `\ufeff---\r\n${plain.replace(/\n/g, '\r\n')}\r\n`;
  const decoratedRefs = scan(decorated).refs;
  const plainRefs = scan(plain).refs;
  assert.deepEqual(
    decoratedRefs.map((ref) => [ref.name, ref.column, ref.kind, ref.required]),
    plainRefs.map((ref) => [ref.name, ref.column, ref.kind, ref.required]),
  );
  assert.deepEqual(decoratedRefs.map((ref) => ref.line), plainRefs.map((ref) => ref.line + 1));
  assert.deepEqual(scan(decorated).serviceNames, ['web']);
});

test('scanCompose keeps a duplicated service key from duplicating its references', () => {
  const source = ['services:', '  web:', '    environment:', '      A: 1', '  web:', '    environment:', '      A: 1'].join('\n');
  const result = scan(source);
  assert.deepEqual(result.serviceNames, ['web']);
  assert.deepEqual(tuples(result.refs), [['A', 4, 7, 'compose-environment', false]]);
});
