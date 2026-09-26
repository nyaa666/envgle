import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCiFile, scanCi } from '../src/scan/ci.js';
import { lineText } from '../src/utils/text.js';
import type { CiScanOptions } from '../src/scan/ci.js';
import type { InfraRef } from '../src/types.js';
import type { YamlDocument, YamlLine } from '../src/scan/yaml.js';

const WORKFLOW = '.github/workflows/ci.yml';
const ACTION = '.github/actions/setup/action.yml';
const GITLAB = '.gitlab-ci.yml';
const AZURE = 'azure-pipelines.yml';
const CIRCLECI = '.circleci/config.yml';
const OPTIONS: CiScanOptions = { defaultEnvironmentKind: 'test', environmentKinds: {} };
const OTHER_OPTIONS: CiScanOptions = {
  defaultEnvironmentKind: 'production',
  environmentKinds: { production: 'production', staging: 'test' },
};

interface Expected {
  readonly name: string;
  readonly line: number;
  readonly at: string;
  readonly occurrence?: number;
  readonly kind: InfraRef['kind'];
  readonly required?: boolean;
}

interface Case {
  readonly title: string;
  readonly path: string;
  readonly source: string;
  readonly expected?: readonly Expected[];
  readonly environments?: readonly string[];
}

const lines = (...rows: string[]): string => rows.join('\n');

/** Builds the plain { lines, byNumber } document shape from raw text, with no YAML parser involved. */
const buildDocument = (text: string): YamlDocument => {
  const parsed = text.split('\n').map((raw, index): YamlLine => {
    const line = raw.replace(/\r$/, '');
    const content = line.trim();
    return {
      number: index + 1,
      indent: line.length - line.trimStart().length,
      text: line,
      content,
      blank: content === '',
      comment: content.startsWith('#'),
    };
  });
  return {
    lines: parsed,
    byNumber: new Map(parsed.map((line): [number, YamlLine] => [line.number, line])),
  };
};

const columnAt = (source: string, line: number, at: string, occurrence: number): number => {
  const text = lineText(source, line);
  let index = -1;
  for (let round = 0; round <= occurrence; round += 1) {
    index = text.indexOf(at, index + 1);
  }
  assert.notEqual(index, -1, `${at} (${occurrence}) is not on line ${line}: ${JSON.stringify(text)}`);
  return index + 1;
};

const expectedRef = (path: string, source: string, item: Expected): InfraRef => ({
  name: item.name,
  file: path,
  line: item.line,
  column: columnAt(source, item.line, item.at, item.occurrence ?? 0),
  kind: item.kind,
  required: item.required ?? item.kind !== 'ci-env',
  refersToFile: false,
  interpolation: item.kind !== 'ci-env',
});

const runCase = (testCase: Case): void => {
  const result = scanCi(testCase.path, buildDocument(testCase.source), OPTIONS);
  const declared = testCase.expected ?? [];
  const expected = declared.map((item) => expectedRef(testCase.path, testCase.source, item));
  assert.deepEqual(result.refs, expected, testCase.title);
  for (const [index, ref] of result.refs.entries()) {
    const text = lineText(testCase.source, ref.line);
    assert.ok(
      text.slice(ref.column - 1).startsWith(declared[index]?.at ?? ''),
      `${testCase.title}: ${ref.name} at ${ref.line}:${ref.column} slices to ${JSON.stringify(text.slice(ref.column - 1))}`,
    );
    assert.ok(ref.line >= 1 && ref.column >= 1, `${testCase.title}: positions are 1-based`);
  }
  assert.deepEqual(result.secrets, expected.filter((ref) => ref.kind === 'ci-secret'), `${testCase.title}: secrets`);
  assert.deepEqual(result.vars, expected.filter((ref) => ref.kind === 'ci-var'), `${testCase.title}: vars`);
  assert.deepEqual(
    result.environments,
    testCase.environments ?? [],
    `${testCase.title}: environments`,
  );
  assert.deepEqual(result.referencedEnvFiles, [], `${testCase.title}: referencedEnvFiles`);
};

const PATH_CASES: readonly [string, boolean][] = [
  ['.github/workflows/ci.yml', true],
  ['.github/workflows/release.yaml', true],
  ['.github/workflows/nested/ci.yml', false],
  ['.github/workflows/.hidden.yml', false],
  ['.github/workflows/docker-compose.yml', false],
  ['.github/workflows/docker-compose.prod.yaml', false],
  ['.github/workflows/compose.yml', false],
  ['.github/workflows/recompose.yml', true],
  ['.github/workflows/README.md', false],
  ['.github/actions/action.yml', true],
  ['.github/actions/setup/action.yml', true],
  ['.github/actions/setup/action.yaml', true],
  ['.github/actions/team/setup/action.yml', true],
  ['.github/actions/setup/setup.yml', false],
  ['.github/actions/setup/Dockerfile', false],
  ['.gitlab-ci.yml', true],
  ['.gitlab/ci/build.yml', true],
  ['.gitlab/ci/nested/build.yml', false],
  ['.gitlab/ci/build.yaml', false],
  ['.gitlab/ci/.gitlab-ci.yml', false],
  ['sub/.gitlab-ci.yml', false],
  ['azure-pipelines.yml', true],
  ['azure-pipelines.yaml', true],
  ['sub/azure-pipelines.yml', false],
  ['azure-pipelines-other.yml', false],
  ['.circleci/config.yml', true],
  ['.circleci/config.yaml', false],
  ['.circleci/nested/config.yml', false],
  ['docker-compose.yml', false],
  ['docker-compose.prod.yaml', false],
  ['compose.yml', false],
  ['foo.yml', false],
  ['workflows/ci.yml', false],
  ['.github/workflows/ci.json', false],
  ['', false],
  ['/', false],
];

const CASES: readonly Case[] = [
  {
    title: 'GitHub env blocks at workflow, job and step level',
    path: WORKFLOW,
    source: lines(
      'name: ci',
      'on:',
      '  push:',
      '    branches: [main]',
      'env:',
      '  WORKFLOW_LEVEL: one',
      '  WORKFLOW_EMPTY:',
      'jobs:',
      '  build:',
      '    env:',
      '      JOB_LEVEL: two',
      '    steps:',
      '      - run: echo hi',
      '        env:',
      '          STEP_LEVEL: three',
    ),
    expected: [
      { name: 'WORKFLOW_LEVEL', line: 6, at: 'WORKFLOW_LEVEL', kind: 'ci-env', required: false },
      { name: 'WORKFLOW_EMPTY', line: 7, at: 'WORKFLOW_EMPTY', kind: 'ci-env', required: true },
      { name: 'JOB_LEVEL', line: 11, at: 'JOB_LEVEL', kind: 'ci-env', required: false },
      { name: 'STEP_LEVEL', line: 15, at: 'STEP_LEVEL', kind: 'ci-env', required: false },
    ],
  },
  {
    title: 'GitHub secrets, vars and env expressions in every expression form',
    path: WORKFLOW,
    source: lines(
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo "${{ secrets.NPM_TOKEN }}"',
      '      - run: echo "${{ secrets.REGISTRY_PASSWORD || \'dev\' }}"',
      '      - run: echo "${{ format(\'{0}\', secrets.FORMAT_KEY) }}"',
      '      - if: startsWith(secrets.GITHUB_TOKEN, \'ghp_\')',
      '        run: echo "${{ vars.DEPLOY_TARGET }}"',
      '      - run: echo "${{ env.JOB_LEVEL }} ${{ env.STEP_LEVEL }}"',
      '      - run: echo "no expression here"',
    ),
    expected: [
      { name: 'NPM_TOKEN', line: 4, at: 'NPM_TOKEN', kind: 'ci-secret', required: true },
      { name: 'REGISTRY_PASSWORD', line: 5, at: 'REGISTRY_PASSWORD', kind: 'ci-secret', required: true },
      { name: 'FORMAT_KEY', line: 6, at: 'FORMAT_KEY', kind: 'ci-secret', required: true },
      { name: 'GITHUB_TOKEN', line: 7, at: 'GITHUB_TOKEN', kind: 'ci-secret', required: true },
      { name: 'DEPLOY_TARGET', line: 8, at: 'DEPLOY_TARGET', kind: 'ci-var', required: false },
      { name: 'JOB_LEVEL', line: 9, at: 'JOB_LEVEL', kind: 'ci-env-usage', required: false },
      { name: 'STEP_LEVEL', line: 9, at: 'STEP_LEVEL', kind: 'ci-env-usage', required: false },
    ],
  },
  {
    title: 'GitHub environments as a string and as a map, de-duplicated in first-appearance order',
    path: WORKFLOW,
    source: lines(
      'jobs:',
      '  build:',
      '    environment: production',
      '  deploy:',
      '    environment:',
      '      name: staging',
      '      url: https://example.com',
      '  again:',
      '    environment: production',
      '  matrix:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - environment: canary',
      '  bare:',
      '    environment:',
      '      url: https://example.org',
    ),
    environments: ['production', 'staging'],
  },
  {
    title: 'a GitHub secrets name list, a flow env map, a bare ${{ and an unbalanced quote are not refs',
    path: WORKFLOW,
    source: lines(
      'name: ci',
      'env: { FLOW_ONLY: 1 }',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "${{"',
      '      - run: echo \'unbalanced "quote $NOPE\'',
      '      - name: checkout',
      '        uses: actions/checkout@v4',
      '        with:',
      '          token: ${{ secrets.GITHUB_TOKEN }}',
      '    secrets:',
      '      - NOT_A_DECLARATION',
      '      - ALSO_NOT_A_DECLARATION',
    ),
    expected: [{ name: 'GITHUB_TOKEN', line: 12, at: 'GITHUB_TOKEN', kind: 'ci-secret', required: true }],
  },
  {
    title: 'an expression mentioned in a comment is still reported',
    path: WORKFLOW,
    source: lines('jobs:', '  build:', '    steps:', '      - run: echo hi # needs ${{ secrets.DOCUMENTED }}'),
    expected: [{ name: 'DOCUMENTED', line: 4, at: 'DOCUMENTED', kind: 'ci-secret', required: true }],
  },
  {
    title: 'a composite action input default is not an env declaration',
    path: ACTION,
    source: lines(
      'name: setup',
      'description: sets things up',
      'inputs:',
      '  token:',
      '    description: the token',
      '    required: true',
      '    default: ${{ secrets.DEFAULT_TOKEN }}',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - run: echo "${{ inputs.token }}"',
      '      env:',
      '        FROM_ACTION: yes',
      '      shell: bash',
    ),
    expected: [
      { name: 'DEFAULT_TOKEN', line: 7, at: 'DEFAULT_TOKEN', kind: 'ci-secret', required: true },
      { name: 'FROM_ACTION', line: 13, at: 'FROM_ACTION', kind: 'ci-env', required: false },
    ],
  },
  {
    title: 'GitLab variables, script bodies and shell expansion forms',
    path: GITLAB,
    source: lines(
      'variables:',
      '  DEPLOY_ENV: staging',
      '  DEPLOY_TOKEN:',
      '  NESTED: $CI_JOB_TOKEN',
      '',
      'stages:',
      '  - build',
      '',
      'build:',
      '  stage: build',
      '  before_script:',
      '    - echo "before $DEPLOY_ENV"',
      '  script:',
      '    - export A=$CI_JOB_TOKEN',
      '    - test -n "$DEPLOY_TOKEN"',
      '    - echo ${DEPLOY_ENV}',
      '  after_script:',
      '    - echo "after $$HOME $1 $@ $(pwd) $?"',
      '  entrypoint: /entry.sh $DEPLOY_ENV',
    ),
    expected: [
      { name: 'DEPLOY_ENV', line: 2, at: 'DEPLOY_ENV', kind: 'ci-env', required: false },
      { name: 'DEPLOY_TOKEN', line: 3, at: 'DEPLOY_TOKEN', kind: 'ci-env', required: true },
      { name: 'NESTED', line: 4, at: 'NESTED', kind: 'ci-env', required: false },
      { name: 'CI_JOB_TOKEN', line: 4, at: 'CI_JOB_TOKEN', kind: 'ci-env-usage', required: false },
      { name: 'DEPLOY_ENV', line: 12, at: 'DEPLOY_ENV', kind: 'ci-env-usage', required: false },
      { name: 'CI_JOB_TOKEN', line: 14, at: 'CI_JOB_TOKEN', kind: 'ci-env-usage', required: false },
      { name: 'DEPLOY_TOKEN', line: 15, at: 'DEPLOY_TOKEN', kind: 'ci-env-usage', required: false },
      { name: 'DEPLOY_ENV', line: 16, at: 'DEPLOY_ENV', kind: 'ci-env-usage', required: false },
      { name: 'DEPLOY_ENV', line: 19, at: 'DEPLOY_ENV', kind: 'ci-env-usage', required: false },
    ],
  },
  {
    title: 'a GitLab include fragment declares only the top-level variables block',
    path: '.gitlab/ci/build.yml',
    source: lines(
      'variables:',
      '  FRAGMENT: yes',
      'compile:',
      '  stage: build',
      '  image: node:22',
      '  script:',
      '    - echo "building $FRAGMENT"',
      '  rules:',
      '    - if: $CI_COMMIT_BRANCH == "main"',
      '      variables:',
      '        JOB_LEVEL: nested',
    ),
    expected: [
      { name: 'FRAGMENT', line: 2, at: 'FRAGMENT', kind: 'ci-env', required: false },
      { name: 'FRAGMENT', line: 7, at: 'FRAGMENT', kind: 'ci-env-usage', required: false },
    ],
  },
  {
    title: 'Azure variables, a top-level env and the macro and template expression forms',
    path: AZURE,
    source: lines(
      'trigger:',
      '  - main',
      '',
      'variables:',
      '  buildConfiguration: Release',
      '  NUGET_FEED:',
      '  - group: shared',
      '',
      'pool:',
      '  vmImage: ubuntu-latest',
      '',
      'env:',
      '  TOP_LEVEL: yes',
      '',
      'steps:',
      '  - script: echo $(Build.SourcesDirectory) $(APP_SECRET)',
      '    displayName: build',
      '  - script: echo "${{ variables.NUGET_FEED }} ${{ env.TOP_LEVEL }}"',
      '    env:',
      '      STEP_LOCAL: 1',
    ),
    expected: [
      { name: 'buildConfiguration', line: 5, at: 'buildConfiguration', kind: 'ci-env', required: false },
      { name: 'NUGET_FEED', line: 6, at: 'NUGET_FEED', kind: 'ci-env', required: true },
      { name: 'TOP_LEVEL', line: 13, at: 'TOP_LEVEL', kind: 'ci-env', required: false },
      { name: 'APP_SECRET', line: 16, at: 'APP_SECRET', kind: 'ci-env-usage', required: false },
      { name: 'NUGET_FEED', line: 18, at: 'NUGET_FEED', kind: 'ci-env-usage', required: false },
      { name: 'TOP_LEVEL', line: 18, at: 'TOP_LEVEL', kind: 'ci-env-usage', required: false },
    ],
  },
  {
    title: 'CircleCI environment map and shell expansion inside its values',
    path: CIRCLECI,
    source: lines(
      'version: 2.1',
      'jobs:',
      '  deploy:',
      '    docker:',
      '      - image: cimg/node:22.0',
      '    environment:',
      '      NODE_ENV: production',
      '      API_URL: https://$HOST/api',
      '      RELEASE: ${GIT_SHA}',
      '    steps:',
      '      - run:',
      '          command: echo deploy',
      'workflows:',
      '  main:',
      '    jobs:',
      '      - deploy',
    ),
    expected: [
      { name: 'NODE_ENV', line: 7, at: 'NODE_ENV', kind: 'ci-env', required: false },
      { name: 'API_URL', line: 8, at: 'API_URL', kind: 'ci-env', required: false },
      { name: 'HOST', line: 8, at: 'HOST', kind: 'ci-env-usage', required: false },
      { name: 'RELEASE', line: 9, at: 'RELEASE', kind: 'ci-env', required: false },
      { name: 'GIT_SHA', line: 9, at: 'GIT_SHA', kind: 'ci-env-usage', required: false },
    ],
  },
  {
    title: 'a quoted env key is reported at the name, not at the quote',
    path: WORKFLOW,
    source: lines('env:', '  "QUOTED": value', "  'SINGLE': 'a # b'", '  PLAIN: value # trailing'),
    expected: [
      { name: 'QUOTED', line: 2, at: 'QUOTED', kind: 'ci-env', required: false },
      { name: 'SINGLE', line: 3, at: 'SINGLE', kind: 'ci-env', required: false },
      { name: 'PLAIN', line: 4, at: 'PLAIN', kind: 'ci-env', required: false },
    ],
  },
  {
    title: 'an expression inside a block scalar body is still a reference',
    path: WORKFLOW,
    source: lines(
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: |',
      '          echo "${{ secrets.BLOCK_TOKEN }}"',
      '          export BARE=$BARE_DEFAULT',
      '        shell: bash',
    ),
    expected: [{ name: 'BLOCK_TOKEN', line: 5, at: 'BLOCK_TOKEN', kind: 'ci-secret', required: true }],
  },
  {
    title: 'one secret referenced three times keeps three positions and one name',
    path: WORKFLOW,
    source: lines(
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo "${{ secrets.MY_TOKEN }}"',
      '      - run: echo "${{ secrets.MY_TOKEN }}"',
      '        env:',
      '          TOKEN_IN_ENV: ${{ secrets.MY_TOKEN }}',
    ),
    expected: [
      { name: 'MY_TOKEN', line: 4, at: 'MY_TOKEN', kind: 'ci-secret', required: true },
      { name: 'MY_TOKEN', line: 5, at: 'MY_TOKEN', kind: 'ci-secret', required: true },
      { name: 'TOKEN_IN_ENV', line: 7, at: 'TOKEN_IN_ENV', kind: 'ci-env', required: false },
      { name: 'MY_TOKEN', line: 7, at: 'MY_TOKEN', kind: 'ci-secret', required: true },
    ],
  },
  {
    title: 'a composite action env block and a CRLF document with no trailing newline',
    path: ACTION,
    source: 'name: a\r\nenv:\r\n  FROM_ACTION: 1\r\nruns:\r\n  using: node20',
    expected: [{ name: 'FROM_ACTION', line: 3, at: 'FROM_ACTION', kind: 'ci-env', required: false }],
  },
  {
    title: 'a key with an unterminated expression is still a declaration',
    path: WORKFLOW,
    source: lines('env:', '  A: ${{', 'jobs:', '  build:', '    environment:'),
    expected: [{ name: 'A', line: 2, at: 'A:', kind: 'ci-env', required: false }],
  },
];

const EMPTY_CASES: readonly Case[] = [
  {
    title: 'a file with only comments and blank lines',
    path: WORKFLOW,
    source: lines('# nothing here', '', '   ', '# env:'),
  },
  {
    title: 'a workflow with no env, secrets or vars',
    path: WORKFLOW,
    source: lines('name: ci', 'on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest'),
  },
  {
    title: 'a root foo.yml is not a CI file, so nothing is scanned',
    path: 'foo.yml',
    source: lines('env:', '  NOT_CI: 1', 'jobs:', '  build:', '    environment: nope'),
  },
  {
    title: 'a docker-compose file that happens to sit in the workflows directory',
    path: '.github/workflows/docker-compose.yml',
    source: lines('services:', '  web:', '    environment:', '      NOT_CI: 1'),
  },
  {
    title: 'GitLab without a variables block or script bodies',
    path: GITLAB,
    source: lines('stages:', '  - build', 'build:', '  stage: build', '  script:', '    - echo hi'),
  },
  {
    title: 'Azure without variables or macros',
    path: AZURE,
    source: lines('trigger:', '  - main', 'pool:', '  vmImage: ubuntu-latest'),
  },
  {
    title: 'CircleCI without an environment map',
    path: CIRCLECI,
    source: lines('version: 2.1', 'jobs:', '  build:', '    steps:', '      - checkout'),
  },
  {
    title: 'an env key whose value is a list',
    path: WORKFLOW,
    source: lines('jobs:', '  build:', '    env:', '      - LIST_ITEM', '      - OTHER_ITEM'),
  },
  {
    title: 'a secrets block listing names',
    path: WORKFLOW,
    source: lines('jobs:', '  build:', '    secrets:', '      - FOO', '      - BAR'),
  },
  {
    title: 'a document truncated in the middle of a block',
    path: WORKFLOW,
    source: lines('jobs:', '  build:', '    env:', '    steps:'),
  },
  {
    title: 'a document that is only a key and a dash',
    path: WORKFLOW,
    source: lines('-', 'env:', '- - - :'),
  },
  {
    title: 'an empty document',
    path: WORKFLOW,
    source: '',
  },
];

const HOSTILE_CASES: readonly string[] = [
  'env: : :\n  : :\n - - - :\n',
  'env:\n\tA: 1\n',
  'jobs:\n  build:\n    env:\n      A: ${{ secrets.',
  'env:\n  A: "${unclosed\n  B: ${\n',
  'jobs:\n  build:\n    steps:\n      - run: |\n          ${{ secrets.A\n',
  '".github\nenv:\n  A: 1\n',
  "'unclosed quote\nenv:\n  A: 1\n",
  'env:\n  A: 1\nenv:\n  A: 2\n',
  'secrets:'.repeat(2000),
  '${{ secrets.'.repeat(2000),
  '$(V'.repeat(2000),
  'env:\u0000\n  A: \u0001\n',
  ':'.repeat(5000),
  ' '.repeat(5000) + 'env:\n  A: 1',
];

test('isCiFile is directory aware and only accepts known CI config paths', () => {
  for (const [path, expected] of PATH_CASES) {
    assert.equal(isCiFile(path), expected, path);
  }
});

test('isCiFile is total for odd input', () => {
  for (const path of ['', '/', '//', '.github/', '.github/workflows/', '..', '\\', 'a'.repeat(1000)]) {
    assert.equal(typeof isCiFile(path), 'boolean', JSON.stringify(path));
  }
});

for (const testCase of CASES) {
  test(`scanCi: ${testCase.title}`, () => {
    runCase(testCase);
  });
}

for (const testCase of EMPTY_CASES) {
  test(`scanCi finds nothing in ${testCase.title}`, () => {
    runCase(testCase);
  });
}

test('scanCi is deterministic and independent of the options it is given', () => {
  const document = buildDocument(
    lines(
      'name: ci',
      'env:',
      '  A: 1',
      'jobs:',
      '  build:',
      '    environment: production',
      '    steps:',
      '      - run: echo "${{ secrets.TOKEN }}" ${{ vars.TARGET }} ${{ env.A }}',
    ),
  );
  const first = scanCi(WORKFLOW, document, OPTIONS);
  const second = scanCi(WORKFLOW, document, OTHER_OPTIONS);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.refs.map((ref) => `${ref.line}:${ref.column}:${ref.kind}:${ref.name}`),
    ['3:3:ci-env:A', '8:32:ci-secret:TOKEN', '8:51:ci-var:TARGET', '8:69:ci-env-usage:A'],
  );
  assert.deepEqual(first.secrets.map((ref) => ref.name), ['TOKEN']);
  assert.deepEqual(first.vars.map((ref) => ref.name), ['TARGET']);
  assert.deepEqual(first.environments, ['production']);
});

test('scanCi sorts refs by position and keeps secrets and vars in that order', () => {
  const result = scanCi(
    WORKFLOW,
    buildDocument(
      lines(
        'jobs:',
        '  build:',
        '    steps:',
        '      - run: echo "${{ vars.V_TWO }} ${{ secrets.S_ONE }}"',
        '        env:',
        '          B: 2',
        '          A: 1',
        '      - run: echo "${{ vars.V_ONE }} ${{ secrets.S_TWO }}"',
      ),
    ),
    OPTIONS,
  );
  assert.deepEqual(
    result.refs.map((ref) => `${ref.line}:${ref.column}`),
    ['4:29', '4:50', '6:11', '7:11', '8:29', '8:50'],
  );
  assert.deepEqual(result.secrets.map((ref) => ref.name), ['S_ONE', 'S_TWO']);
  assert.deepEqual(result.vars.map((ref) => ref.name), ['V_TWO', 'V_ONE']);
});

test('scanCi reads the same document identically through the type-only document shape', () => {
  const source = lines('env:', '  A: 1', '  B: ${{ secrets.S }}');
  const first = scanCi(WORKFLOW, buildDocument(source), OPTIONS);
  const second = scanCi(WORKFLOW, buildDocument(source), OPTIONS);
  assert.deepEqual(first, second);
  assert.deepEqual(first.secrets.length, 1);
});

test('scanCi survives truncated, deeply nested and hostile documents', () => {
  const deep = ['env:'];
  for (let level = 0; level < 200; level += 1) {
    deep.push(`${'  '.repeat(level + 1)}env:`);
  }
  deep.push(`${'  '.repeat(201)}A: 1`);
  for (const source of [...HOSTILE_CASES, deep.join('\n')]) {
    for (const path of [WORKFLOW, ACTION, GITLAB, AZURE, CIRCLECI]) {
      assert.doesNotThrow(() => scanCi(path, buildDocument(source), OPTIONS), path);
      for (const ref of scanCi(path, buildDocument(source), OPTIONS).refs) {
        assert.equal(ref.file, path);
        assert.ok(ref.line >= 1 && Number.isInteger(ref.line), 'line is 1-based');
        assert.ok(ref.column >= 1 && Number.isInteger(ref.column), 'column is 1-based');
        assert.ok(ref.name.length > 0, 'name is never empty');
      }
    }
  }
});

test('scanCi handles a long document without losing a single reference', () => {
  const rows = ['jobs:', '  build:', '    steps:'];
  for (let index = 0; index < 1000; index += 1) {
    rows.push(`      - run: echo "\${{ secrets.TOKEN_${index} }}"`);
  }
  const result = scanCi(WORKFLOW, buildDocument(rows.join('\n')), OPTIONS);
  assert.equal(result.refs.length, 1000);
  assert.equal(result.secrets.length, 1000);
  assert.equal(result.refs[0]?.line, 4);
  assert.equal(result.refs[999]?.line, 1003);
});
