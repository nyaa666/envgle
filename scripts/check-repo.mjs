#!/usr/bin/env node
/**
 * Repository consistency checks that TypeScript cannot express. Zero dependencies,
 * run as part of `npm run lint`. Every check prints `ok` or a concrete failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

const fail = (message) => failures.push(message);
const ok = (message) => checks.push(message);

const walk = (directory, filter) => {
  const entries = [];
  const skip = new Set(['node_modules', 'dist', '.git', '.verify', 'coverage', 'test/fixtures']);
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    const rel = relative(root, absolute).replace(/\\/g, '/');
    if (skip.has(rel) || skip.has(name)) {
      continue;
    }
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      entries.push(...walk(absolute, filter));
    } else if (filter(rel)) {
      entries.push(rel);
    }
  }
  return entries;
};

const source = walk(join(root, 'src'), (rel) => rel.endsWith('.ts'));
const tests = walk(join(root, 'test'), (rel) => rel.endsWith('.ts') && !rel.includes('fixtures'));
const docs = walk(join(root, 'docs'), (rel) => rel.endsWith('.md'));
const rootFiles = walk(root, (rel) => !rel.includes('/') && (rel.endsWith('.md') || rel.endsWith('.yml') || rel.endsWith('.json')));
const scriptFiles = walk(join(root, 'scripts'), (rel) => rel.endsWith('.mjs'));
const yamlFiles = walk(root, (rel) => rel.endsWith('.yml') || rel.endsWith('.yaml'));
const allText = [...source, ...tests, ...docs, ...rootFiles, ...scriptFiles, ...yamlFiles, '.gitignore', '.editorconfig', '.gitattributes'];

// 1. Every rule id is documented with a matching severity.
const typesSource = readFileSync(join(root, 'src/types.ts'), 'utf8');
const union = /export type RuleId =([\s\S]*?);/.exec(typesSource);
const ruleIds = union === null ? [] : [...union[1].matchAll(/'([a-z][a-z0-9-]*)'/g)].map((match) => match[1]);
if (ruleIds.length !== 28) {
  fail(`src/types.ts declares ${ruleIds.length} rule ids, expected 28`);
} else {
  ok(`src/types.ts declares ${ruleIds.length} rule ids`);
}
const rulesDoc = readFileSync(join(root, 'docs/rules.md'), 'utf8');
for (const id of ruleIds) {
  const heading = new RegExp(`^##\\s+${id}\\s*$`, 'm');
  if (!heading.test(rulesDoc)) {
    fail(`docs/rules.md has no "## ${id}" section`);
    continue;
  }
  const severity = new RegExp(`^##\\s+${id}\\s*\\n\\n\\*\\*Severity:\\*\\*\\s+(error|warn|info)`, 'm').exec(rulesDoc);
  if (severity === null) {
    fail(`docs/rules.md section ${id} does not start with a "**Severity:**" line`);
  }
}
ok(`docs/rules.md documents every rule id (${ruleIds.length} checked)`);

// 2. The implemented severities match the documented ones.
const severitySources = ['contract', 'hygiene', 'security'].map((name) =>
  readFileSync(join(root, `src/rules/${name}.ts`), 'utf8'),
).join('\n');
for (const id of ruleIds) {
  const implementation = new RegExp(`id: '${id}',[\\s\\S]{0,400}?severity: '(error|warn|info)'`).exec(severitySources);
  const documentation = new RegExp(`^##\\s+${id}\\s*\\n\\n\\*\\*Severity:\\*\\*\\s+(error|warn|info)`, 'm').exec(rulesDoc);
  if (implementation === null) {
    fail(`rule ${id} has no implementation in src/rules`);
    continue;
  }
  if (documentation !== null && implementation[1] !== documentation[1]) {
    fail(`rule ${id} is ${implementation[1]} in code but ${documentation[1]} in docs/rules.md`);
  }
}
ok('documented severities match the implementations');

// 3. Version consistency.
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versionSource = readFileSync(join(root, 'src/version.ts'), 'utf8');
const version = /VERSION = '([^']+)'/.exec(versionSource);
if (version === null || version[1] !== packageJson.version) {
  fail(`src/version.ts VERSION does not match package.json (${packageJson.version})`);
} else {
  ok(`version is consistent (${packageJson.version})`);
}
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`[${packageJson.version}]`)) {
  fail(`CHANGELOG.md has no entry for ${packageJson.version}`);
} else {
  ok(`CHANGELOG.md documents ${packageJson.version}`);
}

// 4. No runtime dependencies.
const runtimeDeps = Object.keys(packageJson.dependencies ?? {});
if (runtimeDeps.length > 0) {
  fail(`runtime dependencies are forbidden, found ${runtimeDeps.join(', ')}`);
} else {
  ok('no runtime dependencies');
}

// 5. Every source module is reachable from the CLI or the public API.
const importPattern = /(?:from|import)\s+'([^']+)'/g;
const reachable = new Set(['src/cli.ts', 'src/index.ts']);
let grew = true;
const moduleText = new Map(source.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));
while (grew) {
  grew = false;
  for (const [rel, text] of moduleText) {
    if (!reachable.has(rel)) {
      continue;
    }
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith('.')) {
        continue;
      }
      const fromDir = dirname(rel);
      const resolved = relative(root, resolve(fromDir, specifier)).replace(/\\/g, '/');
      const target = resolved.replace(/\.js$/, '.ts');
      if (moduleText.has(target) && !reachable.has(target)) {
        reachable.add(target);
        grew = true;
      }
    }
  }
}
for (const rel of source) {
  if (!reachable.has(rel)) {
    fail(`${rel} is not reachable from src/cli.ts or src/index.ts`);
  }
}
if (!failures.some((message) => message.includes('is not reachable'))) {
  ok(`all ${source.length} source modules are reachable from the entry points`);
}

// 6. Text hygiene: LF endings, one final newline, no trailing whitespace, no tabs, no BOM.
for (const rel of allText) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (text.includes('\r')) {
    fail(`${rel} uses CRLF line endings`);
  }
  if (text.startsWith('\uFEFF')) {
    fail(`${rel} starts with a byte order mark`);
  }
  if (text.length > 0 && !text.endsWith('\n')) {
    fail(`${rel} does not end with a newline`);
  }
  if (text.endsWith('\n\n')) {
    fail(`${rel} ends with more than one newline`);
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (/[ \t]+$/.test(line)) {
      fail(`${rel}:${index + 1} has trailing whitespace`);
      break;
    }
  }
  if (rel.endsWith('.ts') || rel.endsWith('.md') || rel.endsWith('.yml')) {
    if (text.includes('\t')) {
      fail(`${rel} contains a tab character`);
    }
  }
}
ok(`text hygiene checked for ${allText.length} files`);

// 7. No unfinished markers and no `any` in strict TypeScript.
for (const rel of [...source, ...tests]) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (/\b(TODO|FIXME|XXX|HACK)\b/.test(text)) {
    fail(`${rel} contains an unfinished-work marker`);
  }
  if (/:\s*any\b|<any>|as any\b/.test(text)) {
    fail(`${rel} uses the any type`);
  }
  if (/@ts-(ignore|expect-error)/.test(text)) {
    fail(`${rel} suppresses a type error`);
  }
}
ok('no TODO markers, no `any`, no suppressed type errors');

// 8. No emojis anywhere in the tracked text.
const emoji = /\p{Extended_Pictographic}/u;
for (const rel of allText) {
  if (emoji.test(readFileSync(join(root, rel), 'utf8'))) {
    fail(`${rel} contains an emoji`);
  }
}
ok('no emojis in tracked text');

// 9. YAML uses spaces, and workflow files declare least privilege.
for (const rel of yamlFiles) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (/^\s*\t/m.test(text)) {
    fail(`${rel} indents YAML with tabs`);
  }
  if (rel.startsWith('.github/workflows/') && !text.includes('permissions:')) {
    fail(`${rel} does not declare permissions`);
  }
}
ok(`checked ${yamlFiles.length} YAML files`);

// 10. Fences are balanced in markdown.
for (const rel of [...docs, ...rootFiles]) {
  const text = readFileSync(join(root, rel), 'utf8');
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) {
    fail(`${rel} has an unclosed code fence`);
  }
}
ok('markdown code fences are balanced');

// 11. Internal links resolve.
for (const rel of [...docs, ...rootFiles]) {
  const text = readFileSync(join(root, rel), 'utf8');
  const dir = dirname(rel);
  for (const match of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
    const target = match[1];
    if (target === undefined || target.includes('*')) {
      continue;
    }
    const resolved = resolve(dir, target).replace(/\\/g, '/').replace(/^\.\//, '');
    try {
      statSync(resolve(root, resolved));
    } catch {
      fail(`${rel} links to ${target}, which does not exist`);
    }
  }
}
ok('relative links resolve');

// 12. Fixtures stay out of the published type build.
const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
if (!JSON.stringify(tsconfig.exclude ?? []).includes('test/fixtures')) {
  fail('tsconfig.json must exclude test/fixtures');
} else {
  ok('tsconfig excludes the fixture tree');
}

// 13. No machine specific paths anywhere: the project must be usable by anyone.
const MACHINE_PATH = /(?:[A-Za-z]:\\Users\\|\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/)/;
for (const rel of allText) {
  const text = readFileSync(join(root, rel), 'utf8');
  const line = text.split('\n').find((entry) => MACHINE_PATH.test(entry));
  if (line !== undefined) {
    fail(`${rel} contains a machine specific path: ${line.trim().slice(0, 60)}`);
  }
}
ok('no machine specific paths');

for (const message of checks) {
  process.stdout.write(`ok   ${message}\n`);
}
if (failures.length > 0) {
  for (const message of failures) {
    process.stdout.write(`FAIL ${message}\n`);
  }
  process.stdout.write(`\n${failures.length} problem(s) found\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nall ${checks.length} repository checks passed\n`);
}
