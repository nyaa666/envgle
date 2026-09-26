import type { EnvVarDecl, FindingInput, Rule, RuleContext, SourceLocation } from '../types.js';
import { fingerprint, previewValue, sortedUnique } from '../utils/text.js';
import { isIgnoredVariable } from './context.js';
import { buildSecretPatterns, detectSecret, isSecretishVariableName } from './secret-patterns.js';

const SPECIAL_CLASSES: readonly { label: string; test: RegExp }[] = [
  { label: 'whitespace', test: /\s/ },
  { label: '#', test: /#/ },
  { label: '$', test: /\$/ },
  { label: "'", test: /'/ },
  { label: '"', test: /"/ },
  { label: '\\', test: /\\/ },
  { label: '=', test: /=/ },
  { label: 'a line break', test: /\r|\n/ },
];
const PREVIEW_LIMIT = 24;
const MIN_SENSITIVE_LENGTH = 8;

const isExampleDeclPath = (path: string): boolean => {
  const index = path.lastIndexOf('/');
  const base = index === -1 ? path : path.slice(index + 1);
  return base === '.env.example' || base === '.env.sample' || base === '.env.template' || base === '.env.dist';
};

const isExampleDecl = (decl: EnvVarDecl): boolean =>
  decl.kind === 'example' || decl.kind === 'template' || isExampleDeclPath(decl.file);

const isLocalDecl = (decl: EnvVarDecl): boolean => {
  const index = decl.file.lastIndexOf('/');
  const base = index === -1 ? decl.file : decl.file.slice(index + 1);
  return decl.devOnly || base === '.env.local' || base.endsWith('.local');
};

const sortedDecls = (decls: readonly EnvVarDecl[]): EnvVarDecl[] =>
  [...decls].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const firstDeclPerFile = (decls: readonly EnvVarDecl[]): EnvVarDecl[] => {
  const seen = new Set<string>();
  const firsts: EnvVarDecl[] = [];
  for (const decl of sortedDecls(decls)) {
    if (seen.has(decl.file)) {
      continue;
    }
    seen.add(decl.file);
    firsts.push(decl);
  }
  return firsts;
};

const groupsByName = (decls: readonly EnvVarDecl[]): Map<string, EnvVarDecl[]> => {
  const groups = new Map<string, EnvVarDecl[]>();
  for (const decl of decls) {
    if (isExampleDecl(decl)) {
      continue;
    }
    const bucket = groups.get(decl.name);
    if (bucket === undefined) {
      groups.set(decl.name, [decl]);
    } else {
      bucket.push(decl);
    }
  }
  return groups;
};

const specialClasses = (value: string): string[] =>
  SPECIAL_CLASSES.filter((entry) => entry.test.test(value)).map((entry) => entry.label);

/**
 * True when a value must never reach a message: either the name looks like a secret,
 * or the value itself matches a known credential pattern. The name alone is not enough,
 * a variable called `AWS_ID` still holds an AWS key.
 */
const isSensitive = (context: RuleContext, name: string, value: string): boolean => {
  if (isSecretishVariableName(name, context.config.secretNamePattern)) {
    return true;
  }
  if (value.length < MIN_SENSITIVE_LENGTH) {
    return false;
  }
  const patterns = buildSecretPatterns(context.config.secretPatterns);
  return detectSecret({ value, name, secretish: true }, patterns, context.config.weakValues).matched.length > 0;
};

const at = (file: string, line: number, column: number): SourceLocation => ({ file, line, column });

/** Sends a finding to the context unless the location is suppressed for its rule. */
const emit = (context: RuleContext, input: FindingInput): void => {
  if (!context.isSuppressed(input.location, input.ruleId)) {
    context.report(input);
  }
};

/** Reports a key that is assigned more than once inside one dotenv file. */
const checkDuplicateKey = (context: RuleContext): void => {
  for (const decl of context.decls) {
    if (isIgnoredVariable(context.config, decl.name) || decl.duplicateOfLine === null) {
      continue;
    }
    emit(context, {
      ruleId: 'duplicate-key',
      message: `${decl.name} is declared again here; the value from line ${decl.duplicateOfLine} of ${decl.file} is replaced silently`,
      location: at(decl.file, decl.line, decl.column),
      variable: decl.name,
      hint: `delete the earlier assignment on line ${decl.duplicateOfLine}`,
    });
  }
};

/** Reports one variable carrying different values in different real env files. */
const checkConflictingValues = (context: RuleContext): void => {
  for (const [name, decls] of groupsByName(context.decls)) {
    if (isIgnoredVariable(context.config, name)) {
      continue;
    }
    if (new Set(decls.map((decl) => decl.value)).size < 2) {
      continue;
    }
    const files = sortedUnique(decls.map((decl) => decl.file));
    if (files.length < 2) {
      continue;
    }
    const first = sortedDecls(decls)[0];
    if (first === undefined) {
      continue;
    }
    for (const decl of sortedDecls(decls).slice(1)) {
      const sensitive = isSensitive(context, name, first.value) || isSensitive(context, name, decl.value);
      const message = sensitive
        ? `${name} is set to different secret values in ${first.file} and ${decl.file}, and loader precedence decides silently`
        : `${name} is ${previewValue(decl.value, { secretish: false, maxLength: PREVIEW_LIMIT })} in ${decl.file} but ${previewValue(first.value, { secretish: false, maxLength: PREVIEW_LIMIT })} in ${first.file}, and loader precedence decides silently`;
      emit(context, {
        ruleId: 'conflicting-values',
        message,
        location: at(decl.file, decl.line, decl.column),
        variable: name,
        hint: 'make the values identical, or keep one value per environment in clearly named files',
        ...(sensitive ? { fingerprint: fingerprint(decl.value) } : {}),
      });
    }
  }
};

/** Reports `KEY=` in a real env file, where an empty value is almost always a mistake. */
const checkEmptyValue = (context: RuleContext): void => {
  for (const decl of context.decls) {
    if (isIgnoredVariable(context.config, decl.name) || decl.hasValue || isExampleDecl(decl)) {
      continue;
    }
    emit(context, {
      ruleId: 'empty-value',
      message: `${decl.name} has no value in ${decl.file}`,
      location: at(decl.file, decl.line, decl.column),
      variable: decl.name,
      hint: 'give it a value in this file, or remove the line and document the name in the example file',
    });
  }
};

/** Reports unquoted values that other loaders will split on whitespace, # or $. */
const checkUnquotedSpecialChars = (context: RuleContext): void => {
  for (const decl of context.decls) {
    if (isIgnoredVariable(context.config, decl.name) || decl.quoted !== null) {
      continue;
    }
    const classes = specialClasses(decl.value);
    if (classes.length === 0) {
      continue;
    }
    const preview = previewValue(decl.value, {
      secretish: isSensitive(context, decl.name, decl.value),
      maxLength: PREVIEW_LIMIT,
    });
    emit(context, {
      ruleId: 'unquoted-special-chars',
      message: `${decl.name} is unquoted but contains ${classes.join(', ')} in ${decl.file} (${preview})`,
      location: at(decl.file, decl.line, decl.column),
      variable: decl.name,
      hint: 'wrap the value in double quotes so every loader reads the same string',
    });
  }
};

/** Reports inline comments on unquoted values, which different loaders treat differently. */
const checkInlineCommentTruncation = (context: RuleContext): void => {
  for (const decl of context.decls) {
    if (isIgnoredVariable(context.config, decl.name)) {
      continue;
    }
    if (decl.unquotedInlineComment === null || !decl.hasValue) {
      continue;
    }
    emit(context, {
      ruleId: 'inline-comment-truncation',
      message: `${decl.name} has an inline comment on an unquoted value in ${decl.file}; dotenv strips it, but docker --env-file and set -a; source keep it in the value`,
      location: at(decl.file, decl.line, decl.column),
      variable: decl.name,
      hint: 'move the comment to its own line, or quote the value and keep the comment outside the quotes',
    });
  }
};

/** Reports `export KEY=...`, which dotenv, --env-file and systemd do not accept. */
const checkExportPrefix = (context: RuleContext): void => {
  for (const decl of context.decls) {
    if (isIgnoredVariable(context.config, decl.name) || !decl.exported) {
      continue;
    }
    emit(context, {
      ruleId: 'export-prefix',
      message: `${decl.name} uses the export prefix in ${decl.file}, which is not valid for dotenv, docker run --env-file or systemd`,
      location: at(decl.file, decl.line, decl.column),
      variable: decl.name,
      hint: 'drop the export keyword; shell loaders export every line anyway',
    });
  }
};

/** Reports parse problems found in an env file, prefixed with their kind. */
const checkUnterminatedQuote = (context: RuleContext): void => {
  const seen = new Set<string>();
  for (const file of context.files.values()) {
    for (const issue of file.issues) {
      const key = `${file.path}\u0000${issue.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const body =
        issue.kind === 'unterminated-quote'
          ? `${issue.message} (${file.path} line ${issue.line})`
          : `${issue.kind}: ${issue.message} (${file.path} line ${issue.line})`;
      emit(context, {
        ruleId: 'unterminated-quote',
        message: body,
        location: at(file.path, issue.line, issue.column),
        hint: 'fix the syntax or quote the value so every loader parses the same line',
      });
    }
  }
};

/** Reports ${VAR} expansion in a shared file, which only dotenv-expand understands. */
const checkExpansionUnsupported = (context: RuleContext): void => {
  for (const [name, decls] of groupsByName(context.decls)) {
    if (isIgnoredVariable(context.config, name)) {
      continue;
    }
    for (const decl of firstDeclPerFile(decls)) {
      if (!decl.shared || decl.references.length === 0 || isLocalDecl(decl)) {
        continue;
      }
      emit(context, {
        ruleId: 'expansion-unsupported',
        message: `${decl.name} expands ${decl.references.map((ref) => `\${${ref}}`).join(', ')} in ${decl.file}; docker compose env_file, systemd and most CI loaders do not support it`,
        location: at(decl.file, decl.line, decl.column),
        variable: name,
        hint: 'precompute the value or use dotenv-expand',
      });
    }
  }
};

export const hygieneRules: readonly Rule[] = [
  {
    id: 'duplicate-key',
    title: 'Duplicate key in one env file',
    severity: 'error',
    description: 'The same name is assigned twice in a single dotenv file, so the last assignment wins.',
    docs: 'docs/rules.md#duplicate-key',
    remediation: 'Delete the earlier assignment and keep one definition per file.',
    tags: ['correctness'],
    check: checkDuplicateKey,
  },
  {
    id: 'conflicting-values',
    title: 'Same variable, different values per file',
    severity: 'warn',
    description: 'A variable holds different values in two or more real env files, resolved only by loader precedence.',
    docs: 'docs/rules.md#conflicting-values',
    remediation: 'Align the values, or split the variable per environment with clear file names.',
    tags: ['consistency'],
    check: checkConflictingValues,
  },
  {
    id: 'empty-value',
    title: 'Empty value outside the example file',
    severity: 'info',
    description: 'A key is assigned with no value in a real env file, which usually means an unfilled placeholder.',
    docs: 'docs/rules.md#empty-value',
    remediation: 'Fill in the value, or drop the line and document the name in the example file.',
    tags: ['hygiene'],
    check: checkEmptyValue,
  },
  {
    id: 'unquoted-special-chars',
    title: 'Unquoted value with special characters',
    severity: 'warn',
    description: 'An unquoted value contains whitespace, #, $, quotes, backslashes, = or a line break.',
    docs: 'docs/rules.md#unquoted-special-chars',
    remediation: 'Wrap the value in double quotes so dotenv, Docker and systemd read the same string.',
    tags: ['hygiene'],
    check: checkUnquotedSpecialChars,
  },
  {
    id: 'inline-comment-truncation',
    title: 'Inline comment changes the value in some loaders',
    severity: 'warn',
    description: 'An unquoted value is followed by an inline comment that dotenv strips but Docker and shell sourcing keep.',
    docs: 'docs/rules.md#inline-comment-truncation',
    remediation: 'Move the comment to its own line or quote the value.',
    tags: ['correctness'],
    check: checkInlineCommentTruncation,
  },
  {
    id: 'export-prefix',
    title: 'export prefix in a dotenv file',
    severity: 'info',
    description: 'A key is written as export KEY=..., which is invalid for dotenv, --env-file and systemd.',
    docs: 'docs/rules.md#export-prefix',
    remediation: 'Remove the export keyword.',
    tags: ['hygiene'],
    check: checkExportPrefix,
  },
  {
    id: 'unterminated-quote',
    title: 'Env file line does not parse',
    severity: 'error',
    description: 'A line has an unterminated quote, no separator or otherwise cannot be parsed.',
    docs: 'docs/rules.md#unterminated-quote',
    remediation: 'Fix the syntax so every dotenv implementation parses the line identically.',
    tags: ['correctness'],
    check: checkUnterminatedQuote,
  },
  {
    id: 'expansion-unsupported',
    title: 'Variable expansion in a shared env file',
    severity: 'warn',
    description: 'A shared env file uses ${VAR} expansion, a dotenv-expand feature other loaders ignore.',
    docs: 'docs/rules.md#expansion-unsupported',
    remediation: 'Precompute the value, or load the file through dotenv-expand.',
    tags: ['correctness'],
    check: checkExpansionUnsupported,
  },
];
