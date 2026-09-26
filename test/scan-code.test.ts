import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { scanCode, scanTextFile, usageLocation } from '../src/scan/code.js';
import { lineText, offsetToLineColumn } from '../src/utils/text.js';
import { detectLanguage } from '../src/utils/walk.js';
import { makeTempRepo } from './helpers.js';
import type { EnvUsage, Language, SourceLocation } from '../src/types.js';
import type { WalkedFile } from '../src/utils/walk.js';
import type { TempRepo } from './helpers.js';

const PATH = 'app/config.js';

interface Expected {
  readonly name: string;
  readonly line: number;
  readonly at: string;
  readonly accessor: string;
  readonly hasFallback?: boolean;
  readonly required?: boolean;
  readonly viaImport?: boolean;
  readonly fallbackLiteral?: string | null;
}

interface Case {
  readonly title: string;
  readonly language: Language;
  readonly source: string;
  readonly expected: readonly Expected[];
}

const expectedUsage = (language: Language, item: Expected, column: number): EnvUsage => ({
  name: item.name,
  file: PATH,
  line: item.line,
  column,
  language,
  accessor: item.accessor,
  hasFallback: item.hasFallback ?? false,
  required: item.required ?? false,
  viaImport: item.viaImport ?? false,
  fallbackLiteral: item.fallbackLiteral ?? null,
});

const runCase = (testCase: Case): void => {
  const lines = testCase.source.split('\n');
  const usages = scanTextFile({
    path: PATH,
    language: testCase.language,
    text: testCase.source,
    lines,
  });
  const expected = testCase.expected.map((item) => {
    const line = lineText(testCase.source, item.line);
    const column = line.indexOf(item.at) + 1;
    assert.notEqual(column, 0, `${testCase.title}: ${item.at} is not on line ${item.line}`);
    return expectedUsage(testCase.language, item, column);
  });
  assert.deepEqual(usages, expected, testCase.title);
  for (const usage of usages) {
    const sliced = lineText(testCase.source, usage.line).slice(usage.column - 1);
    const match = testCase.expected[usages.indexOf(usage)];
    assert.ok(
      sliced.startsWith(match?.at ?? ''),
      `${testCase.title}: position ${usage.line}:${usage.column} slices to ${JSON.stringify(sliced)}`,
    );
    assert.equal(lineText(testCase.source, usage.line).charAt(usage.column - 1).length, 1);
  }
};

const scan = (language: Language, source: string): readonly EnvUsage[] =>
  scanTextFile({ path: PATH, language, text: source, lines: source.split('\n') });

const names = (language: Language, source: string): string[] =>
  scan(language, source).map((usage) => usage.name);

const lines = (...rows: string[]): string => rows.join('\n');

const CASES: readonly Case[] = [
  {
    title: 'javascript and typescript',
    language: 'typescript',
    source: lines(
      'const a = process.env.PLAIN_ONE;',
      "const b = process.env['BRACKET_ONE'];",
      "const c = process.env.COALESCE ?? 'dev';",
      'const d = process.env.ALTERNATE || "other";',
      "const { PORT, HOST: host, API_KEY = 'secret', ['QUOTED_KEY']: quoted } = process.env;",
      'const e = import.meta.env.VITE_API_URL;',
      "const f = import.meta.env['VITE_OTHER'];",
      'const g = Bun.env.BUN_URL;',
      "const h = Bun.env['BUN_KEY'];",
      "const i = Deno.env.get('DENO_ONE');",
      "const j = Deno.env.get('DENO_TWO', 'fallback');",
      'const k = process.env[name];',
      'const l = globalThis.process.env.GLOBAL_RECEIVER;',
      "const m = globalThis.process.env['GLOBAL_BRACKET'];",
      'const n = process?.env?.OPTIONAL ?? "d";',
      'const o = myprocess.env.NOT_PROCESS;',
    ),
    expected: [
      { name: 'PLAIN_ONE', line: 1, at: 'PLAIN_ONE', accessor: 'process.env' },
      { name: 'BRACKET_ONE', line: 2, at: "'BRACKET_ONE'", accessor: 'process.env' },
      {
        name: 'COALESCE',
        line: 3,
        at: 'COALESCE',
        accessor: 'process.env',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      {
        name: 'ALTERNATE',
        line: 4,
        at: 'ALTERNATE',
        accessor: 'process.env',
        hasFallback: true,
        fallbackLiteral: 'other',
      },
      { name: 'PORT', line: 5, at: 'PORT', accessor: 'process.env' },
      { name: 'HOST', line: 5, at: 'HOST: host', accessor: 'process.env' },
      {
        name: 'API_KEY',
        line: 5,
        at: "API_KEY = 'secret'",
        accessor: 'process.env',
        hasFallback: true,
        fallbackLiteral: 'secret',
      },
      { name: 'QUOTED_KEY', line: 5, at: "'QUOTED_KEY'", accessor: 'process.env' },
      { name: 'VITE_API_URL', line: 6, at: 'VITE_API_URL', accessor: 'import.meta.env' },
      { name: 'VITE_OTHER', line: 7, at: "'VITE_OTHER'", accessor: 'import.meta.env' },
      { name: 'BUN_URL', line: 8, at: 'BUN_URL', accessor: 'Bun.env' },
      { name: 'BUN_KEY', line: 9, at: "'BUN_KEY'", accessor: 'Bun.env' },
      { name: 'DENO_ONE', line: 10, at: "'DENO_ONE'", accessor: 'Deno.env.get' },
      {
        name: 'DENO_TWO',
        line: 11,
        at: "'DENO_TWO', 'fallback'",
        accessor: 'Deno.env.get',
        hasFallback: true,
        fallbackLiteral: 'fallback',
      },
      { name: 'GLOBAL_RECEIVER', line: 13, at: 'GLOBAL_RECEIVER', accessor: 'process.env' },
      { name: 'GLOBAL_BRACKET', line: 14, at: "'GLOBAL_BRACKET'", accessor: 'process.env' },
      {
        name: 'OPTIONAL',
        line: 15,
        at: 'OPTIONAL ?? "d"',
        accessor: 'process.env',
        hasFallback: true,
        fallbackLiteral: 'd',
      },
    ],
  },
  {
    title: 'sveltekit and nuxt static env imports',
    language: 'typescript',
    source: lines(
      "import { DATABASE_URL, JWT_SECRET as secret } from '$env/static/private';",
      "import { PUBLIC_API_URL } from '$env/static/public';",
    ),
    expected: [
      {
        name: 'DATABASE_URL',
        line: 1,
        at: 'DATABASE_URL,',
        accessor: '$env/static/private',
        required: true,
        viaImport: true,
      },
      {
        name: 'JWT_SECRET',
        line: 1,
        at: 'JWT_SECRET as secret',
        accessor: '$env/static/private',
        required: true,
        viaImport: true,
      },
      {
        name: 'PUBLIC_API_URL',
        line: 2,
        at: 'PUBLIC_API_URL',
        accessor: '$env/static/public',
        required: true,
        viaImport: true,
      },
    ],
  },
  {
    title: 'sveltekit dynamic env imports',
    language: 'typescript',
    source: lines(
      "import { env } from '$env/dynamic/private';",
      "import { publicEnv } from '$env/dynamic/public';",
      'const a = env.DYNAMIC_ONE;',
      "const b = env['DYNAMIC_TWO'];",
      'const c = publicEnv.DYNAMIC_THREE;',
      'const d = somethingElse.DYNAMIC_FOUR;',
    ),
    expected: [
      {
        name: 'DYNAMIC_ONE',
        line: 3,
        at: 'DYNAMIC_ONE',
        accessor: '$env/dynamic/private',
        viaImport: true,
      },
      {
        name: 'DYNAMIC_TWO',
        line: 4,
        at: "'DYNAMIC_TWO'",
        accessor: '$env/dynamic/private',
        viaImport: true,
      },
      {
        name: 'DYNAMIC_THREE',
        line: 5,
        at: 'DYNAMIC_THREE',
        accessor: '$env/dynamic/public',
        viaImport: true,
      },
    ],
  },
  {
    title: 'python os.environ and os.getenv',
    language: 'python',
    source: lines(
      'import os',
      'from os import environ as env_map',
      "a = os.environ['REQUIRED_ONE']",
      "b = os.environ.get('OPTIONAL_ONE')",
      "c = os.environ.get('DEFAULTED', 'dev')",
      "d = os.getenv('GETENV_ONE')",
      "e = os.getenv('GETENV_TWO', 'local')",
      "f = os.environ.setdefault('SEEDED_ONE', 'seed')",
      "os.environ['WRITE_ONLY'] = 'nope'",
      "g = env_map['ALIAS_ONE']",
      "h = env_map.get('ALIAS_TWO')",
      "i = os.environ.get('CONCAT', os.getenv('INNER'))",
    ),
    expected: [
      { name: 'REQUIRED_ONE', line: 3, at: "'REQUIRED_ONE'", accessor: 'os.environ', required: true },
      { name: 'OPTIONAL_ONE', line: 4, at: "'OPTIONAL_ONE'", accessor: 'os.environ' },
      {
        name: 'DEFAULTED',
        line: 5,
        at: "'DEFAULTED', 'dev'",
        accessor: 'os.environ',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      { name: 'GETENV_ONE', line: 6, at: "'GETENV_ONE'", accessor: 'os.getenv' },
      {
        name: 'GETENV_TWO',
        line: 7,
        at: "'GETENV_TWO', 'local'",
        accessor: 'os.getenv',
        hasFallback: true,
        fallbackLiteral: 'local',
      },
      {
        name: 'SEEDED_ONE',
        line: 8,
        at: "'SEEDED_ONE', 'seed'",
        accessor: 'os.environ',
        hasFallback: true,
        fallbackLiteral: 'seed',
      },
      { name: 'ALIAS_ONE', line: 10, at: "'ALIAS_ONE'", accessor: 'os.environ', required: true },
      { name: 'ALIAS_TWO', line: 11, at: "'ALIAS_TWO'", accessor: 'os.environ' },
      { name: 'CONCAT', line: 12, at: "'CONCAT', os.getenv", accessor: 'os.environ', hasFallback: true },
      { name: 'INNER', line: 12, at: "'INNER'", accessor: 'os.getenv' },
    ],
  },
  {
    title: 'python pydantic settings',
    language: 'python',
    source: lines(
      'from pydantic_settings import BaseSettings',
      '',
      '',
      'class AppSettings(BaseSettings):',
      "    model_config = SettingsConfigDict(env_file='.env')",
      '    port: int = 8080',
      '    host: str',
      "    token: str = 'abc'",
      '',
      '',
      'class NotSettings:',
      '    ignored: str',
    ),
    expected: [
      {
        name: 'port',
        line: 6,
        at: 'port: int = 8080',
        accessor: 'BaseSettings',
        hasFallback: true,
      },
      { name: 'host', line: 7, at: 'host: str', accessor: 'BaseSettings', required: true },
      {
        name: 'token',
        line: 8,
        at: "token: str = 'abc'",
        accessor: 'BaseSettings',
        hasFallback: true,
        fallbackLiteral: 'abc',
      },
    ],
  },
  {
    title: 'go',
    language: 'go',
    source: lines(
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      ')',
      '',
      'func main() {',
      '\ta := os.Getenv("GO_PLAIN")',
      '\tb := os.LookupEnv("GO_LOOKUP")',
      '\tc := Getenv("GO_BARE")',
      '\tos.Setenv("GO_WRITE", "x")',
      '\td := os.ExpandEnv("$GO_EXPAND")',
      '\t_ = os.Environ()',
      '}',
    ),
    expected: [
      { name: 'GO_PLAIN', line: 9, at: '"GO_PLAIN"', accessor: 'os.Getenv' },
      { name: 'GO_LOOKUP', line: 10, at: '"GO_LOOKUP"', accessor: 'os.LookupEnv', hasFallback: true },
      { name: 'GO_BARE', line: 11, at: '"GO_BARE"', accessor: 'os.Getenv' },
    ],
  },
  {
    title: 'rust',
    language: 'rust',
    source: lines(
      'use std::env::var;',
      '',
      'fn main() {',
      '\tlet a = var("RUST_BARE");',
      '\tlet b = env::var("RUST_PLAIN");',
      '\tlet c = std::env::var("RUST_STD").unwrap();',
      '\tlet d = env::var("RUST_EXPECT").expect("boom");',
      '\tlet e = env::var("RUST_UNWRAP_OR").unwrap_or("dev");',
      '\tlet f = env::var("RUST_DEFAULT").unwrap_or_default();',
      '\tlet g = env::var("RUST_OK").ok();',
      '\tlet h = dotenvy::var("RUST_DOTENV");',
      '\tlet _ = env::vars();',
      '}',
    ),
    expected: [
      { name: 'RUST_BARE', line: 4, at: '"RUST_BARE"', accessor: 'env::var' },
      { name: 'RUST_PLAIN', line: 5, at: '"RUST_PLAIN"', accessor: 'env::var' },
      { name: 'RUST_STD', line: 6, at: '"RUST_STD"', accessor: 'env::var', required: true },
      { name: 'RUST_EXPECT', line: 7, at: '"RUST_EXPECT"', accessor: 'env::var', required: true },
      {
        name: 'RUST_UNWRAP_OR',
        line: 8,
        at: '"RUST_UNWRAP_OR"',
        accessor: 'env::var',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      {
        name: 'RUST_DEFAULT',
        line: 9,
        at: '"RUST_DEFAULT"',
        accessor: 'env::var',
        hasFallback: true,
      },
      { name: 'RUST_OK', line: 10, at: '"RUST_OK"', accessor: 'env::var', hasFallback: true },
      { name: 'RUST_DOTENV', line: 11, at: '"RUST_DOTENV"', accessor: 'env::var' },
    ],
  },
  {
    title: 'java',
    language: 'java',
    source: lines(
      'class App {',
      '  String a = System.getenv("JAVA_ONE");',
      '  String b = System.getenv().get("JAVA_TWO");',
      '  String c = System.getProperty("JAVA_THREE");',
      '}',
    ),
    expected: [
      { name: 'JAVA_ONE', line: 2, at: '"JAVA_ONE"', accessor: 'System.getenv' },
      { name: 'JAVA_TWO', line: 3, at: '"JAVA_TWO"', accessor: 'System.getenv' },
      { name: 'JAVA_THREE', line: 4, at: '"JAVA_THREE"', accessor: 'System.getProperty' },
    ],
  },
  {
    title: 'kotlin',
    language: 'kotlin',
    source: lines(
      'fun read(): String = System.getenv("KOTLIN_ONE") ?: ""',
      'val b = System.getenv().get("KOTLIN_TWO")',
      'val c = System.getProperty("KOTLIN_THREE", "dev")',
    ),
    expected: [
      { name: 'KOTLIN_ONE', line: 1, at: '"KOTLIN_ONE"', accessor: 'System.getenv' },
      { name: 'KOTLIN_TWO', line: 2, at: '"KOTLIN_TWO"', accessor: 'System.getenv' },
      {
        name: 'KOTLIN_THREE',
        line: 3,
        at: '"KOTLIN_THREE", "dev"',
        accessor: 'System.getProperty',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
    ],
  },
  {
    title: 'csharp',
    language: 'csharp',
    source: lines(
      'class App {',
      '  void M(IConfiguration configuration, ConfigurationBuilder builder) {',
      '    var a = Environment.GetEnvironmentVariable("CS_ONE");',
      '    var b = Environment.GetEnvironmentVariable("CS_TWO", EnvironmentVariableTarget.User);',
      '    var c = builder.Configuration["CS_THREE"];',
      '    var d = configuration["CS_FOUR"];',
      '    var e = builder.Configuration.GetConnectionString("CS_FIVE");',
      '  }',
      '}',
    ),
    expected: [
      { name: 'CS_ONE', line: 3, at: '"CS_ONE"', accessor: 'Environment.GetEnvironmentVariable' },
      {
        name: 'CS_TWO',
        line: 4,
        at: '"CS_TWO", EnvironmentVariableTarget.User',
        accessor: 'Environment.GetEnvironmentVariable',
      },
      { name: 'CS_THREE', line: 5, at: '"CS_THREE"', accessor: 'IConfiguration' },
      { name: 'CS_FOUR', line: 6, at: '"CS_FOUR"', accessor: 'IConfiguration' },
      {
        name: 'CS_FIVE',
        line: 7,
        at: '"CS_FIVE"',
        accessor: 'GetConnectionString',
        required: true,
      },
    ],
  },
  {
    title: 'ruby',
    language: 'ruby',
    source: lines(
      "a = ENV['RUBY_ONE']",
      "b = ENV['RUBY_TWO'] || 'dev'",
      "c = ENV.fetch('RUBY_THREE')",
      "d = ENV.fetch('RUBY_FOUR', 'dev')",
      "e = ENV.fetch('RUBY_FIVE') { 'block' }",
      "ENV['RUBY_WRITE'] = 'x'",
      "f = MYENV['RUBY_PREFIXED']",
    ),
    expected: [
      { name: 'RUBY_ONE', line: 1, at: "'RUBY_ONE'", accessor: 'ENV', required: true },
      {
        name: 'RUBY_TWO',
        line: 2,
        at: "'RUBY_TWO'] || 'dev'",
        accessor: 'ENV',
        required: true,
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      { name: 'RUBY_THREE', line: 3, at: "'RUBY_THREE'", accessor: 'ENV.fetch', required: true },
      {
        name: 'RUBY_FOUR',
        line: 4,
        at: "'RUBY_FOUR', 'dev'",
        accessor: 'ENV.fetch',
        required: true,
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      {
        name: 'RUBY_FIVE',
        line: 5,
        at: "'RUBY_FIVE') { 'block' }",
        accessor: 'ENV.fetch',
        required: true,
        hasFallback: true,
        fallbackLiteral: 'block',
      },
    ],
  },
  {
    title: 'php',
    language: 'php',
    source: lines(
      '<?php',
      "$a = getenv('PHP_ONE');",
      "$b = getenv('PHP_TWO', true);",
      "$c = $_ENV['PHP_THREE'];",
      "$d = $_SERVER['PHP_FOUR'];",
      "$e = env('PHP_FIVE');",
      "$f = env('PHP_SIX', 'dev');",
      "$g = Env::get('PHP_SEVEN');",
      "$h = Env::get('PHP_EIGHT', 'dev');",
      "$i = $_ENV['PHP_WRITE'] = 'x';",
    ),
    expected: [
      { name: 'PHP_ONE', line: 2, at: "'PHP_ONE'", accessor: 'getenv' },
      { name: 'PHP_TWO', line: 3, at: "'PHP_TWO', true", accessor: 'getenv' },
      { name: 'PHP_THREE', line: 4, at: "'PHP_THREE'", accessor: '$_ENV' },
      { name: 'PHP_FOUR', line: 5, at: "'PHP_FOUR'", accessor: '$_SERVER' },
      { name: 'PHP_FIVE', line: 6, at: "'PHP_FIVE'", accessor: 'env' },
      {
        name: 'PHP_SIX',
        line: 7,
        at: "'PHP_SIX', 'dev'",
        accessor: 'env',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      { name: 'PHP_SEVEN', line: 8, at: "'PHP_SEVEN'", accessor: 'env' },
      {
        name: 'PHP_EIGHT',
        line: 9,
        at: "'PHP_EIGHT', 'dev'",
        accessor: 'env',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
    ],
  },
  {
    title: 'perl',
    language: 'perl',
    source: lines(
      'use strict;',
      'my $a = $ENV{PERL_ONE};',
      "my $b = $ENV{'PERL_TWO'};",
      "my $c = $ENV{PERL_THREE} // 'dev';",
    ),
    expected: [
      { name: 'PERL_ONE', line: 2, at: 'PERL_ONE', accessor: '%ENV' },
      { name: 'PERL_TWO', line: 3, at: "'PERL_TWO'", accessor: '%ENV' },
      {
        name: 'PERL_THREE',
        line: 4,
        at: "PERL_THREE} // 'dev'",
        accessor: '%ENV',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
    ],
  },
  {
    title: 'shell',
    language: 'shell',
    source: lines(
      '#!/bin/bash',
      ': "${SHELL_ONE}"',
      ': "${SHELL_TWO:-dev}"',
      ': "${SHELL_THREE-d}"',
      ': "${SHELL_FOUR:?boom}"',
      ': "${SHELL_FIVE?boom}"',
      'echo $SHELL_BARE',
      'echo "expanded $SHELL_DOUBLE"',
      "echo 'literal $SHELL_SINGLE'",
      'echo \\$SHELL_ESCAPED',
      '# echo $SHELL_COMMENT',
      'export SHELL_EXPORTED=1',
      'printenv SHELL_PRINTENV',
      'echo $1 $? $# $@ $* $$ $0 $_',
      'echo $(date) $((1 + 2))',
    ),
    expected: [
      { name: 'SHELL_ONE', line: 2, at: 'SHELL_ONE', accessor: 'shell-parameter' },
      {
        name: 'SHELL_TWO',
        line: 3,
        at: 'SHELL_TWO:-dev',
        accessor: 'shell-parameter',
        hasFallback: true,
        fallbackLiteral: 'dev',
      },
      {
        name: 'SHELL_THREE',
        line: 4,
        at: 'SHELL_THREE-d',
        accessor: 'shell-parameter',
        hasFallback: true,
        fallbackLiteral: 'd',
      },
      {
        name: 'SHELL_FOUR',
        line: 5,
        at: 'SHELL_FOUR:?boom',
        accessor: 'shell-parameter',
        required: true,
      },
      {
        name: 'SHELL_FIVE',
        line: 6,
        at: 'SHELL_FIVE?boom',
        accessor: 'shell-parameter',
        required: true,
      },
      { name: 'SHELL_BARE', line: 7, at: 'SHELL_BARE', accessor: 'shell-parameter' },
      { name: 'SHELL_DOUBLE', line: 8, at: 'SHELL_DOUBLE', accessor: 'shell-parameter' },
      {
        name: 'SHELL_PRINTENV',
        line: 13,
        at: 'SHELL_PRINTENV',
        accessor: 'printenv',
        required: true,
      },
    ],
  },
  {
    title: 'batch',
    language: 'batch',
    source: lines(
      '@echo off',
      'rem echo %BATCH_COMMENT%',
      ':: echo %BATCH_COLON%',
      'if "%BATCH_ONE%"=="x" echo hi',
      'if defined BATCH_TWO (',
      '  echo %BATCH_THREE%',
      ')',
      'if not defined %PATH% echo no',
      'if defined ERRORLEVEL 1 echo err',
      'set "BATCH_WRITE=value"',
      'set BATCH_FOUR=%BATCH_FOUR%',
      'echo %~dp0 %CD% %BATCH_FIVE%',
    ),
    expected: [
      { name: 'BATCH_ONE', line: 4, at: 'BATCH_ONE', accessor: 'batch-parameter' },
      { name: 'BATCH_TWO', line: 5, at: 'BATCH_TWO', accessor: 'batch-parameter' },
      { name: 'BATCH_THREE', line: 6, at: 'BATCH_THREE', accessor: 'batch-parameter' },
      { name: 'BATCH_FIVE', line: 12, at: 'BATCH_FIVE', accessor: 'batch-parameter' },
    ],
  },
  {
    title: 'swift',
    language: 'swift',
    source: lines(
      'import Foundation',
      '',
      'let a = ProcessInfo.processInfo.environment["SWIFT_ONE"]',
      'let b = environment["SWIFT_TWO"]',
      'let c = ProcessInfo.processInfo.environment["SWIFT_THREE"] ?? "d"',
    ),
    expected: [
      {
        name: 'SWIFT_ONE',
        line: 3,
        at: '"SWIFT_ONE"',
        accessor: 'ProcessInfo.processInfo.environment',
      },
      {
        name: 'SWIFT_TWO',
        line: 4,
        at: '"SWIFT_TWO"',
        accessor: 'ProcessInfo.processInfo.environment',
      },
      {
        name: 'SWIFT_THREE',
        line: 5,
        at: '"SWIFT_THREE"',
        accessor: 'ProcessInfo.processInfo.environment',
      },
    ],
  },
  {
    title: 'dart',
    language: 'dart',
    source: lines(
      'void main() {',
      "  var a = Platform.environment['DART_ONE'];",
      '  var b = Platform.environment["DART_TWO"];',
      "  var c = String.fromEnvironment('DART_THREE');",
    ),
    expected: [
      { name: 'DART_ONE', line: 2, at: "'DART_ONE'", accessor: 'Platform.environment' },
      { name: 'DART_TWO', line: 3, at: '"DART_TWO"', accessor: 'Platform.environment' },
      { name: 'DART_THREE', line: 4, at: "'DART_THREE'", accessor: 'String.fromEnvironment' },
    ],
  },
  {
    title: 'elixir',
    language: 'elixir',
    source: lines(
      'defmodule App do',
      '  def read do',
      '    System.get_env("ELIXIR_ONE")',
      '    System.fetch_env("ELIXIR_TWO")',
      '    System.fetch_env!("ELIXIR_THREE")',
      '    System.put_env("ELIXIR_WRITE", "x")',
      '  end',
      'end',
    ),
    expected: [
      { name: 'ELIXIR_ONE', line: 3, at: '"ELIXIR_ONE"', accessor: 'System.get_env' },
      { name: 'ELIXIR_TWO', line: 4, at: '"ELIXIR_TWO"', accessor: 'System.fetch_env' },
      {
        name: 'ELIXIR_THREE',
        line: 5,
        at: '"ELIXIR_THREE"',
        accessor: 'System.fetch_env',
        required: true,
      },
    ],
  },
];

for (const testCase of CASES) {
  test(`scanTextFile detects reads: ${testCase.title}`, () => {
    runCase(testCase);
  });
}

test('scanTextFile reports javascript, typescript and unknown identifiers the same way', () => {
  const source = lines("const a = process.env.SHARED_ONE;", 'const b = process.env[name];');
  assert.deepEqual(names('javascript', source), names('typescript', source));
  assert.deepEqual(scan('unknown', source), []);
});

test('scanTextFile ignores reads inside comments and strings of every family', () => {
  const cases: readonly (readonly [Language, string])[] = [
    ['typescript', lines('// process.env.LINE_COMMENT', '/* process.env.BLOCK_COMMENT */', 'const a = "process.env.IN_STRING";')],
    ['java', lines('// System.getenv("JAVA_COMMENT")', 'String a = "System.getenv(\\"JAVA_STRING\\")";')],
    ['python', lines('# os.environ["PY_COMMENT"]', '"""os.environ["PY_TRIPLE"]"""', "a = 'os.environ[\"PY_STRING\"]'")],
    ['ruby', lines("# ENV['RUBY_COMMENT']", "a = \"ENV['RUBY_STRING']\"")],
    ['shell', lines('# echo $SHELL_COMMENT', "echo 'echo $SHELL_SINGLE'")],
    ['batch', lines('rem echo %BATCH_COMMENT%', ':: echo %BATCH_COLON%')],
    ['go', lines('// os.Getenv("GO_COMMENT")', 'a := "os.Getenv(\\"GO_STRING\\")"')],
    ['perl', lines('# $ENV{PERL_COMMENT}', "my $a = \"$ENV{PERL_STRING}\";")],
  ];
  for (const [language, source] of cases) {
    assert.deepEqual(names(language, source), [], `${language} reported a usage from a comment or string`);
  }
});

test('scanTextFile ignores writes, dynamic access and non-read calls', () => {
  const cases: readonly (readonly [Language, string])[] = [
    ['python', "os.environ['PY_WRITE'] = 'x'\nos.environ['PY_AUGMENT'] += 'x'\nos.environ.copy()"],
    ['go', 'os.Setenv("GO_WRITE", "x")\nos.Unsetenv("GO_UNSET")\n_ = os.Environ()\nos.ExpandEnv("$GO_EXPAND")'],
    ['ruby', "ENV['RUBY_WRITE'] = 'x'"],
    ['php', "$_ENV['PHP_WRITE'] = 'x'\nputenv('PHP_PUTENV=x')"],
    ['elixir', 'System.put_env("ELIXIR_WRITE", "x")'],
    ['typescript', 'process.env[name]\nprocess.env[prefix + name]\nconst all = process.env'],
    ['shell', 'export SHELL_EXPORTED=1\nSHELL_ASSIGNED=1\nunset SHELL_UNSET'],
    ['batch', 'set "BATCH_WRITE=value"\nset BATCH_TWO=value'],
    ['rust', 'std::env::set_var("RUST_WRITE", "x")\nlet _ = env::vars();'],
    ['java', 'System.getenv();\nSystem.setProperty("JAVA_WRITE", "x");'],
  ];
  for (const [language, source] of cases) {
    assert.deepEqual(names(language, source), [], `${language} reported a write or a dynamic read`);
  }
});

test('scanTextFile reports a 1-based position that maps back to the name token', () => {
  const source = lines('function main() {', '  const port = process.env.PORT;', '}');
  const offset = source.indexOf('PORT');
  const expected = offsetToLineColumn(source, offset);
  assert.deepEqual(expected, { line: 2, column: 28 });
  assert.deepEqual(scanTextFile({ path: PATH, language: 'typescript', text: source, lines: source.split('\n') }), [
    expectedUsage('typescript', { name: 'PORT', line: 2, at: 'PORT', accessor: 'process.env' }, 28),
  ]);
});

test('scanTextFile only trusts the bare swift environment form when Foundation is imported', () => {
  assert.deepEqual(names('swift', 'let a = environment["SWIFT_NO_IMPORT"]'), []);
  assert.deepEqual(names('swift', 'import SwiftUI\nlet a = environment["SWIFT_REEXPORTED"]'), ['SWIFT_REEXPORTED']);
});

test('scanTextFile is deterministic and never reports the same usage twice', () => {
  const source = lines('const a = process.env.DUPLICATED_ONE;', 'const b = process.env.DUPLICATED_ONE;');
  const file = { path: PATH, language: 'typescript' as const, text: source, lines: source.split('\n') };
  const first = scanTextFile(file);
  assert.deepEqual(first, scanTextFile(file));
  assert.equal(first.length, 2);
  assert.deepEqual(
    first.map((usage) => `${usage.line}:${usage.column}`),
    ['1:23', '2:23'],
  );
});

test('scanTextFile survives unterminated strings, lone backticks and truncated input', () => {
  const cases: readonly (readonly [Language, string])[] = [
    ['typescript', 'const a = `unterminated ${process.env.IN_TEMPLATE'],
    ['typescript', "const a = 'unterminated process.env.AFTER"],
    ['python', 'a = """unterminated os.environ["AFTER"]'],
    ['shell', 'echo "unterminated $SHELL_AFTER'],
    ['batch', 'echo "unterminated %BATCH_AFTER'],
    ['typescript', 'const a = process.env.'],
    ['go', 'os.Getenv('],
    ['typescript', ''],
  ];
  for (const [language, source] of cases) {
    assert.doesNotThrow(() => scan(language, source), `${language} threw on malformed input`);
  }
  assert.deepEqual(names('typescript', 'const a = `unterminated ${process.env.IN_TEMPLATE'), ['IN_TEMPLATE']);
});

test('scanTextFile sorts by line, then column, then name', () => {
  const source = lines(
    'const z = process.env.ZETA_ONE;',
    'const a = process.env.ALPHA_ONE;',
    "const b = process.env['BETA_ONE'];",
  );
  assert.deepEqual(
    scan('typescript', source).map((usage) => usage.name),
    ['ZETA_ONE', 'ALPHA_ONE', 'BETA_ONE'],
  );
});

test('usageLocation returns the file, line and column of a usage', () => {
  const usage = scan('typescript', 'const a = process.env.PORT;')[0];
  assert.ok(usage !== undefined);
  const location: SourceLocation = usageLocation(usage);
  assert.deepEqual(location, { file: PATH, line: 1, column: 23 });
});

const walked = (repo: TempRepo, relativePath: string, bytes?: number): WalkedFile => {
  const absolutePath = repo.path(relativePath);
  return {
    absolutePath,
    relativePath,
    bytes: bytes ?? 1024,
    language: detectLanguage(relativePath),
  };
};

const withRepo = async (run: (repo: TempRepo) => Promise<void>): Promise<void> => {
  const repo = makeTempRepo();
  try {
    await run(repo);
  } finally {
    repo.cleanup();
  }
};

test('scanTextFile skips a batch write even when the line is longer than the scan window', () => {
  const filler = 'echo '.padEnd(80, 'x');
  assert.deepEqual(names('batch', `${filler}\nset LONG_NAME=%LONG_NAME%\necho %KEPT_ONE%`), ['KEPT_ONE']);
  assert.deepEqual(names('batch', `${filler}\nset LONG_NAME=literal\necho %KEPT_ONE%`), ['KEPT_ONE']);
});

test('scanTextFile stays fast and silent on pathological, unbalanced input', () => {
  const cases: readonly (readonly [Language, string])[] = [
    ['typescript', '{'.repeat(200_000)],
    ['typescript', `${'{ a,'.repeat(50_000)}`],
    ['typescript', `const a = ${'['.repeat(100_000)}`],
    ['python', 'os.environ['.repeat(50_000)],
    ['typescript', `import {${'A,'.repeat(50_000)}`],
    ['shell', '${'.repeat(100_000)],
    ['batch', '%'.repeat(200_000)],
    ['csharp', 'new []{'.repeat(50_000)],
  ];
  const started = performance.now();
  for (const [language, text] of cases) {
    assert.doesNotThrow(() => scan(language, text), `${language} threw on unbalanced input`);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `unbalanced input took ${Math.round(elapsed)} ms`);
});

test('scanCode merges, sorts and de-duplicates usages across a real directory', async () => {
  await withRepo(async (repo) => {
    repo.write('src/b.js', lines("const b = process.env['B_ONE'];", 'const c = process.env.A_ONE;'));
    repo.write('src/a.ts', 'const a = process.env.A_ONE;');
    repo.write('docs/readme.md', '```js\nconst x = process.env.FENCE_VAR;\n```\n');
    repo.write('config/settings.yaml', 'x: process.env.YAML_VAR\n');
    writeFileSync(repo.path('src/blob.ts'), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x00, 0x01, 0x02]));

    const files = [
      walked(repo, 'src/a.ts'),
      walked(repo, 'src/b.js'),
      walked(repo, 'docs/readme.md'),
      walked(repo, 'config/settings.yaml'),
      walked(repo, 'src/blob.ts'),
      walked(repo, 'src/a.ts'),
      { ...walked(repo, 'src/missing.ts'), absolutePath: repo.path('src/missing.ts') },
      { ...walked(repo, 'src/huge.ts'), bytes: 9 * 1024 * 1024 },
    ];

    const usages = await scanCode(files);
    assert.deepEqual(
      usages.map((usage) => `${usage.file}:${usage.line}:${usage.column}:${usage.name}`),
      ['src/a.ts:1:23:A_ONE', 'src/b.js:1:23:B_ONE', 'src/b.js:2:23:A_ONE'],
    );
    for (const usage of usages) {
      assert.equal(usage.language, detectLanguage(usage.file));
    }
  });
});

test('scanCode returns an empty list for a directory without scannable files', async () => {
  await withRepo(async (repo) => {
    repo.write('README.md', 'process.env.NOTHING');
    assert.deepEqual(await scanCode([walked(repo, 'README.md')]), []);
  });
});

test('scanCode skips a file it cannot read as text instead of throwing', async () => {
  await withRepo(async (repo) => {
    repo.write('src/denied.ts', 'const a = process.env.DENIED_ONE;');
    const directory = repo.path('src/denied.ts');
    rmSync(directory);
    mkdirSync(directory, { recursive: true });
    const usages = await scanCode([{ ...walked(repo, 'src/denied.ts'), absolutePath: directory }]);
    assert.deepEqual(usages, []);
  });
});

test('scanCode skips a file that disappears between walk and read', async () => {
  await withRepo(async (repo) => {
    const target = repo.write('src/gone.ts', 'const a = process.env.GONE_ONE;');
    rmSync(target);
    assert.deepEqual(await scanCode([{ ...walked(repo, 'src/gone.ts'), absolutePath: target }]), []);
  });
});

test('scanCode scans 50 000 reads in a 2 MB file in well under 500 ms', () => {
  const header = 'export const perfValue = process.env.';
  const rows: string[] = [];
  for (let index = 0; rows.length < 50_000; index += 1) {
    rows.push(`${header}PERF_${index.toString().padStart(5, '0')};`);
  }
  const source = `${rows.join('\n')}\n`;
  assert.ok(source.length >= 2 * 1024 * 1024, `generated only ${source.length} bytes`);

  const started = performance.now();
  const usages = scanTextFile({ path: 'src/perf.ts', language: 'typescript', text: source, lines: source.split('\n') });
  const elapsed = performance.now() - started;

  assert.equal(usages.length, 50_000);
  assert.equal(usages[0]?.name, 'PERF_00000');
  assert.equal(usages[49_999]?.name, 'PERF_49999');
  assert.ok(elapsed < 500, `scanning 50 000 reads took ${Math.round(elapsed)} ms`);
});

test('regression: comments and strings preceded by indentation are masked', () => {
  const cases: readonly { text: string; language: Language; path: string }[] = [
    { language: 'typescript', path: 'src/a.ts', text: 'export interface X {\n  /** process.env.HIDDEN */\n  readonly a: string;\n}\nconst real = process.env.VISIBLE;' },
    { language: 'typescript', path: 'src/b.ts', text: 'const a = 1;\n  // process.env.HIDDEN\nconst real = process.env.VISIBLE;' },
    { language: 'typescript', path: 'src/c.ts', text: 'function f() {\n\treturn process.env.VISIBLE;\n}\n/* process.env.HIDDEN */' },
    { language: 'javascript', path: 'd.js', text: 'const s = "x";\n  /* process.env.HIDDEN */\nconst real = process.env.VISIBLE;' },
    { language: 'python', path: 'e.py', text: 'def f():\n    # os.environ["HIDDEN"]\n    return os.environ["VISIBLE"]' },
    { language: 'go', path: 'f.go', text: 'package main\n\nfunc f() {\n\t// os.Getenv("HIDDEN")\n\treturn os.Getenv("VISIBLE")\n}' },
    { language: 'rust', path: 'g.rs', text: 'fn f() {\n    // env::var("HIDDEN").unwrap();\n    let v = env::var("VISIBLE").unwrap();\n}' },
    { language: 'ruby', path: 'h.rb', text: "def f\n  # ENV['HIDDEN']\n  ENV['VISIBLE']\nend" },
    { language: 'shell', path: 'i.sh', text: 'f() {\n  # echo "$HIDDEN"\n  echo "$VISIBLE"\n}' },
    { language: 'php', path: 'j.php', text: "<?php\n// getenv('HIDDEN')\n\\$v = getenv('VISIBLE');\n" },
    { language: 'csharp', path: 'k.cs', text: 'class K {\n  // Environment.GetEnvironmentVariable("HIDDEN")\n  void M() { var v = Environment.GetEnvironmentVariable("VISIBLE"); }\n}' },
  ];
  for (const item of cases) {
    const usages = scanTextFile({ path: item.path, language: item.language, text: item.text, lines: item.text.split('\n') });
    const names = usages.map((usage) => usage.name).sort();
    assert.deepEqual(names, ['VISIBLE'], `${item.path} reported ${JSON.stringify(names)}`);
  }
});

test('regression: a comment character right after spaces is never treated as code', () => {
  const text = ['class A {', '    // process.env.A', '    /* process.env.B */', '    const c = process.env.C;', '}'].join('\n');
  const usages = scanTextFile({ path: 'x.ts', language: 'typescript', text, lines: text.split('\n') });
  assert.deepEqual(usages.map((usage) => usage.name), ['C']);
});
