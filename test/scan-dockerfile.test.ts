import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDockerfile, scanDockerfile } from '../src/scan/dockerfile.js';
import { lineText } from '../src/utils/text.js';
import type { InfraRef } from '../src/types.js';

const PATH = 'Dockerfile';

interface Expected {
  readonly name: string;
  readonly line: number;
  /** Text that starts exactly at the reported column, used to derive that column. */
  readonly at: string;
  readonly occurrence?: number;
  readonly textLine?: number;
  readonly kind: InfraRef['kind'];
  readonly required?: boolean;
  readonly interpolation?: boolean;
}

interface Case {
  readonly title: string;
  readonly source: string;
  readonly expected: readonly Expected[];
  readonly envNames?: readonly string[];
  readonly argNames?: readonly string[];
}

interface Garbage {
  readonly title: string;
  readonly source: string;
  readonly expected?: readonly Expected[];
  readonly envNames?: readonly string[];
  readonly argNames?: readonly string[];
}

const lines = (...rows: string[]): string => rows.join('\n');

const columnAt = (source: string, line: number, at: string, occurrence: number): number => {
  const text = lineText(source, line);
  let index = -1;
  for (let round = 0; round <= occurrence; round += 1) {
    index = text.indexOf(at, index + 1);
  }
  assert.notEqual(index, -1, `${at} (${occurrence}) is not on line ${line}: ${JSON.stringify(text)}`);
  return index + 1;
};

const expectedRef = (source: string, item: Expected): InfraRef => ({
  name: item.name,
  file: PATH,
  line: item.line,
  column: columnAt(source, item.textLine ?? item.line, item.at, item.occurrence ?? 0),
  kind: item.kind,
  required: item.required ?? false,
  refersToFile: false,
  interpolation: item.interpolation ?? item.kind === 'dockerfile-usage',
});

const runCase = (testCase: Garbage): void => {
  const result = scanDockerfile(PATH, testCase.source);
  const expected = (testCase.expected ?? []).map((item) => expectedRef(testCase.source, item));
  assert.deepEqual(result.refs, expected, testCase.title);
  for (const [index, ref] of result.refs.entries()) {
    const item = testCase.expected?.[index];
    const at = item?.at ?? '';
    const text = lineText(testCase.source, item?.textLine ?? ref.line);
    assert.ok(at.length > 0, `${testCase.title}: every ref needs an anchor`);
    assert.ok(
      text.slice(ref.column - 1).startsWith(at),
      `${testCase.title}: ${ref.name} at ${ref.line}:${ref.column} slices to ${JSON.stringify(text.slice(ref.column - 1))}`,
    );
    assert.ok(ref.line >= 1 && ref.column >= 1, `${testCase.title}: positions are 1-based`);
    assert.equal(ref.file, PATH, testCase.title);
    assert.equal(ref.refersToFile, false, testCase.title);
  }
  assert.deepEqual(result.envNames, testCase.envNames ?? [], `${testCase.title}: envNames`);
  assert.deepEqual(result.argNames, testCase.argNames ?? [], `${testCase.title}: argNames`);
  assert.deepEqual(result.referencedPaths, [], `${testCase.title}: referencedPaths`);
};

const NAME_CASES: readonly [string, boolean][] = [
  ['Dockerfile', true],
  ['Containerfile', true],
  ['dockerfile', true],
  ['CONTAINERFILE', true],
  ['Dockerfile.prod', true],
  ['Dockerfile.dev.debug', true],
  ['Containerfile.release', true],
  ['app.Dockerfile', true],
  ['deploy.Containerfile', true],
  ['a-b_c.Dockerfile', true],
  ['infra/docker/Dockerfile', true],
  ['docker/api.Dockerfile', true],
  ['infra\\docker\\Dockerfile.prod', true],
  ['./Dockerfile', true],
  ['Dockerfilex', false],
  ['mydockerfile', false],
  ['Docker', false],
  ['Container', false],
  ['docker-compose.yml', false],
  ['foo.Dockerfile.bak', false],
  ['notaDockerfile.txt', false],
  ['src/index.ts', false],
  ['docker/Dockerfiles', false],
  ['api.Dockerfile.prod', false],
  ['', false],
];

const CASES: readonly Case[] = [
  {
    title: 'FROM starts a stage and a bare ARG is required',
    source: lines('FROM node:22 AS base', 'ARG NODE_VERSION', 'RUN echo $NODE_VERSION'),
    expected: [
      { name: 'NODE_VERSION', line: 2, at: 'NODE_VERSION', kind: 'dockerfile-arg', required: true },
      { name: 'NODE_VERSION', line: 3, at: 'NODE_VERSION', kind: 'dockerfile-usage' },
    ],
    argNames: ['NODE_VERSION'],
  },
  {
    title: 'ARG --global with a default is not required and its ${OTHER} is a usage, not an arg',
    source: lines('ARG --global BASE_TAG=${REGISTRY}/app', 'FROM alpine AS build'),
    expected: [
      { name: 'BASE_TAG', line: 1, at: 'BASE_TAG', kind: 'dockerfile-arg' },
      { name: 'REGISTRY', line: 1, at: 'REGISTRY', kind: 'dockerfile-usage' },
    ],
    argNames: ['BASE_TAG'],
  },
  {
    title: 'stage ARGs join the global ones in first-appearance order',
    source: lines('ARG GLOBAL_ONE=1', 'FROM node:22', 'ARG STAGE_ONE', 'FROM node:22 AS prod', 'ARG GLOBAL_TWO=2'),
    expected: [
      { name: 'GLOBAL_ONE', line: 1, at: 'GLOBAL_ONE', kind: 'dockerfile-arg' },
      { name: 'STAGE_ONE', line: 3, at: 'STAGE_ONE', kind: 'dockerfile-arg', required: true },
      { name: 'GLOBAL_TWO', line: 5, at: 'GLOBAL_TWO', kind: 'dockerfile-arg' },
    ],
    argNames: ['GLOBAL_ONE', 'STAGE_ONE', 'GLOBAL_TWO'],
  },
  {
    title: 'ENV multi-pair form yields one ref per pair, empty values included',
    source: lines('ENV APP_ENV=prod APP_DEBUG=0 NAME=app BLANK='),
    expected: [
      { name: 'APP_ENV', line: 1, at: 'APP_ENV', kind: 'dockerfile-env' },
      { name: 'APP_DEBUG', line: 1, at: 'APP_DEBUG', kind: 'dockerfile-env' },
      { name: 'NAME', line: 1, at: 'NAME', kind: 'dockerfile-env' },
      { name: 'BLANK', line: 1, at: 'BLANK', kind: 'dockerfile-env' },
    ],
    envNames: ['APP_ENV', 'APP_DEBUG', 'NAME', 'BLANK'],
  },
  {
    title: 'ENV legacy form takes the rest of the line as one value',
    source: lines('ENV APP_ENV prod', 'ENV APP_DEBUG 0'),
    expected: [
      { name: 'APP_ENV', line: 1, at: 'APP_ENV', kind: 'dockerfile-env' },
      { name: 'APP_DEBUG', line: 2, at: 'APP_DEBUG', kind: 'dockerfile-env' },
    ],
    envNames: ['APP_ENV', 'APP_DEBUG'],
  },
  {
    title: 'ENV values expand other variables and a bare ENV NAME is invalid',
    source: lines(
      'ENV DATABASE_URL=postgres://$DB_USER@db/$DB_NAME',
      'ENV EMPTY',
      'ENV QUOTED="$TOKEN"',
      'ENV PATH="/usr/local/bin:$PATH"',
      'ENV A="x y" B=2',
    ),
    expected: [
      { name: 'DATABASE_URL', line: 1, at: 'DATABASE_URL', kind: 'dockerfile-env' },
      { name: 'DB_USER', line: 1, at: 'DB_USER', kind: 'dockerfile-usage' },
      { name: 'DB_NAME', line: 1, at: 'DB_NAME', kind: 'dockerfile-usage' },
      { name: 'QUOTED', line: 3, at: 'QUOTED', kind: 'dockerfile-env' },
      { name: 'TOKEN', line: 3, at: 'TOKEN', kind: 'dockerfile-usage' },
      { name: 'PATH', line: 4, at: 'PATH', occurrence: 0, kind: 'dockerfile-env' },
      { name: 'PATH', line: 4, at: 'PATH', occurrence: 1, kind: 'dockerfile-usage' },
      { name: 'A', line: 5, at: 'A=', kind: 'dockerfile-env' },
      { name: 'B', line: 5, at: 'B=', kind: 'dockerfile-env' },
    ],
    envNames: ['DATABASE_URL', 'QUOTED', 'PATH', 'A', 'B'],
  },
  {
    title: 'every instruction contributes $NAME, ${NAME}, ${NAME:-d} and ${NAME-d} usages',
    source: lines(
      'FROM node:22',
      'WORKDIR /app/$APP_DIR',
      'USER $APP_USER',
      'EXPOSE $PORT',
      'RUN echo $A ${B} ${C:-dev} ${D-alt}',
      'CMD ["sh", "-c", "echo $E"]',
      'ENTRYPOINT ["/entry.sh", "$F"]',
      'COPY --from=build /out /out',
      'ADD https://example.com/$ASSET /tmp/',
      'HEALTHCHECK --interval=5s CMD curl http://localhost:$PORT/health',
    ),
    expected: [
      { name: 'APP_DIR', line: 2, at: 'APP_DIR', kind: 'dockerfile-usage' },
      { name: 'APP_USER', line: 3, at: 'APP_USER', kind: 'dockerfile-usage' },
      { name: 'PORT', line: 4, at: 'PORT', kind: 'dockerfile-usage' },
      { name: 'A', line: 5, at: 'A ', kind: 'dockerfile-usage' },
      { name: 'B', line: 5, at: 'B}', kind: 'dockerfile-usage' },
      { name: 'C', line: 5, at: 'C:', kind: 'dockerfile-usage' },
      { name: 'D', line: 5, at: 'D-', kind: 'dockerfile-usage' },
      { name: 'E', line: 6, at: 'E"]', kind: 'dockerfile-usage' },
      { name: 'F', line: 7, at: 'F"]', kind: 'dockerfile-usage' },
      { name: 'ASSET', line: 9, at: 'ASSET', kind: 'dockerfile-usage' },
      { name: 'PORT', line: 10, at: 'PORT', kind: 'dockerfile-usage' },
    ],
  },
  {
    title: 'shell specials, $( ), $(( ) and an escaped dollar are not variables',
    source: lines('RUN echo $(pwd) $((1 + 1)) $$HOME $1 $? $# $@ $* && echo "$A"', 'RUN echo \\$LITERAL ${UNFINISHED'),
    expected: [{ name: 'A', line: 1, at: 'A"', kind: 'dockerfile-usage' }],
  },
  {
    title: 'a wide brace default still resolves its name',
    source: `RUN echo \${A:-${'x'.repeat(3000)}}\n`,
    expected: [{ name: 'A', line: 1, at: 'A:-', kind: 'dockerfile-usage' }],
  },
  {
    title: 'COPY --from=<stage> is not a variable reference',
    source: lines(
      'FROM alpine AS build',
      'FROM alpine AS prod',
      'COPY --from=build /a /b',
      'COPY --from=$STAGE /c /d',
      'RUN echo $STAGE',
    ),
    expected: [{ name: 'STAGE', line: 5, at: 'STAGE', kind: 'dockerfile-usage' }],
  },
  {
    title: 'a continued instruction reports the first physical line and the piece column',
    source: lines(
      'FROM node:22 AS base',
      'RUN npm ci && \\',
      '    npm run build -- --mode $BUILD_MODE',
      'ENV APP_ENV=prod \\',
      '    APP_DEBUG=0',
    ),
    expected: [
      { name: 'BUILD_MODE', line: 2, at: 'BUILD_MODE', textLine: 3, kind: 'dockerfile-usage' },
      { name: 'APP_ENV', line: 4, at: 'APP_ENV', kind: 'dockerfile-env' },
      { name: 'APP_DEBUG', line: 4, at: 'APP_DEBUG', textLine: 5, kind: 'dockerfile-env' },
    ],
    envNames: ['APP_ENV', 'APP_DEBUG'],
  },
  {
    title: 'an unterminated continuation and a joined ARG line stay readable',
    source: lines('ARG NAME=1 \\', 'ARG OTHER=2', 'RUN echo tail', 'ENV LATE=1 \\'),
    expected: [
      { name: 'NAME', line: 1, at: 'NAME', kind: 'dockerfile-arg' },
      { name: 'LATE', line: 4, at: 'LATE', kind: 'dockerfile-env' },
    ],
    envNames: ['LATE'],
    argNames: ['NAME'],
  },
  {
    title: 'an unterminated brace in an ARG default still declares the arg',
    source: 'ARG A=${B',
    expected: [{ name: 'A', line: 1, at: 'A=', kind: 'dockerfile-arg' }],
    argNames: ['A'],
  },
  {
    title: 'comments, the escape directive, tabs and blank lines are skipped',
    source: lines(
      '# syntax=docker/dockerfile:1',
      '# escape=`',
      '',
      'FROM alpine',
      '\tENV A=1',
      '   # ENV NOPE=2',
      'RUN echo $A # a shell comment is not a Dockerfile comment',
    ),
    expected: [
      { name: 'A', line: 5, at: 'A=1', kind: 'dockerfile-env' },
      { name: 'A', line: 7, at: 'A ', kind: 'dockerfile-usage' },
    ],
    envNames: ['A'],
  },
  {
    title: 'CRLF line endings and a missing trailing newline',
    source: 'FROM node:22\r\nENV A=1\r\nRUN echo $B',
    expected: [
      { name: 'A', line: 2, at: 'A=1', kind: 'dockerfile-env' },
      { name: 'B', line: 3, at: 'B', kind: 'dockerfile-usage' },
    ],
    envNames: ['A'],
  },
  {
    title: 'one variable in three places is declared once and used three times',
    source: lines(
      'FROM node:22 AS base',
      'ARG TARGET',
      'ENV APP_ENV=prod',
      'RUN echo $APP_ENV',
      'RUN echo ${APP_ENV}',
      'CMD echo $APP_ENV',
    ),
    expected: [
      { name: 'TARGET', line: 2, at: 'TARGET', kind: 'dockerfile-arg', required: true },
      { name: 'APP_ENV', line: 3, at: 'APP_ENV', kind: 'dockerfile-env' },
      { name: 'APP_ENV', line: 4, at: 'APP_ENV', kind: 'dockerfile-usage' },
      { name: 'APP_ENV', line: 5, at: 'APP_ENV', kind: 'dockerfile-usage' },
      { name: 'APP_ENV', line: 6, at: 'APP_ENV', kind: 'dockerfile-usage' },
    ],
    envNames: ['APP_ENV'],
    argNames: ['TARGET'],
  },
];

const EMPTY_CASES: readonly Garbage[] = [
  { title: 'an empty file', source: '' },
  { title: 'only newlines', source: '\n\n\n' },
  { title: 'only whitespace', source: '  \t\n \t' },
  { title: 'a comment-only file', source: '# ENV NOPE=1\n# RUN echo $NOPE\n#\n' },
  { title: 'garbage without an instruction keyword', source: '!!! ??? ###\n$$$$\n12345\n' },
  { title: 'instructions without arguments', source: 'RUN\nENV\nARG\nFROM\n' },
  { title: 'a truncated variable expansion', source: 'RUN echo ${\nRUN echo $\n' },
  { title: 'control characters and a leading space', source: '\u0000\u0001 FROM x\nRUN echo \u0002\n' },
  { title: 'a line of dollars', source: `RUN echo ${'$'.repeat(5000)}` },
  { title: 'a brace wider than the parser accepts', source: `RUN echo \${A:-${'x'.repeat(70_000)}}\n` },
  { title: 'an invalid ENV name', source: 'ENV 1BAD=x\nENV =1\nENV --\n' },
];

const HOSTILE_CASES: readonly string[] = [
  '\u0000\u0001\u0002',
  'FROM \u0000',
  'ENV =',
  'ENV A=',
  'ENV A=B=',
  'ENV --',
  'ENV A=1\u0000$B',
  'ARG --',
  'ARG =-1',
  'ARG A=1 --extra',
  'RUN ${',
  'RUN ${:-}',
  'RUN ${:??}',
  'FROM'.repeat(2000),
  '$'.repeat(20_000),
  '{'.repeat(20_000),
  '${A:-'.repeat(4000),
  '--from='.repeat(2000),
  'COPY --from=--from=--from=$A',
  lines('RUN echo a \\', '   \\', '     \\', '   $LATE'),
  lines('FROM a AS b', 'ENV A=1', '\u0000ENV B=2'),
];

test('isDockerfile accepts the Dockerfile and Containerfile naming schemes', () => {
  for (const [path, expected] of NAME_CASES) {
    assert.equal(isDockerfile(path), expected, path);
  }
});

test('isDockerfile is total for odd input', () => {
  for (const path of ['', '/', '.', '//', 'Dockerfile/', 'a'.repeat(500), '\\', 'Docker file', '-Dockerfile']) {
    assert.equal(typeof isDockerfile(path), 'boolean', JSON.stringify(path));
  }
});

for (const testCase of CASES) {
  test(`scanDockerfile: ${testCase.title}`, () => {
    runCase(testCase);
  });
}

for (const testCase of EMPTY_CASES) {
  test(`scanDockerfile finds nothing in ${testCase.title}`, () => {
    runCase(testCase);
  });
}

test('scanDockerfile reports the file it was given and stays deterministic', () => {
  const source = lines('FROM alpine', 'ENV A=$B', 'RUN echo ${A}');
  const first = scanDockerfile('docker/prod.Dockerfile', source);
  const second = scanDockerfile('docker/prod.Dockerfile', source);
  assert.deepEqual(first, second);
  assert.equal(isDockerfile('docker/prod.Dockerfile'), true);
  assert.equal(isDockerfile('docker/api.Dockerfile.prod'), false);
  assert.deepEqual(
    first.refs.map((ref) => `${ref.file}:${ref.line}:${ref.column}:${ref.kind}`),
    [
      'docker/prod.Dockerfile:2:5:dockerfile-env',
      'docker/prod.Dockerfile:2:8:dockerfile-usage',
      'docker/prod.Dockerfile:3:12:dockerfile-usage',
    ],
  );
});

test('scanDockerfile survives truncated and hostile input without throwing', () => {
  for (const source of HOSTILE_CASES) {
    assert.doesNotThrow(() => scanDockerfile(PATH, source), JSON.stringify(source.slice(0, 40)));
    for (const ref of scanDockerfile(PATH, source).refs) {
      assert.equal(ref.file, PATH);
      assert.ok(ref.line >= 1, 'line is 1-based');
      assert.ok(ref.column >= 1, 'column is 1-based');
      assert.ok(ref.name.length > 0, 'name is never empty');
      assert.ok(Number.isInteger(ref.line) && Number.isInteger(ref.column), 'positions are integers');
    }
  }
});

test('scanDockerfile reads a long file linearly', () => {
  const rows = ['FROM node:22 AS base'];
  for (let index = 0; index < 2000; index += 1) {
    rows.push(`RUN echo build $STAGE_${index} && npm run task-${index} -- --mode ${'m'.repeat(200)}`);
  }
  const result = scanDockerfile(PATH, rows.join('\n'));
  assert.equal(result.refs.length, 2000);
  assert.equal(result.envNames.length, 0);
  assert.equal(result.argNames.length, 0);
  assert.equal(result.refs[0]?.line, 2);
  assert.equal(result.refs[1999]?.line, 2001);
});
