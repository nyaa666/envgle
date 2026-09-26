import { matchGlob } from '../utils/text.js';
import type { EnvFileKind } from '../types.js';

export interface EnvFileClassification {
  readonly kind: EnvFileKind;
  /** Intended to be committed and shared: not a personal override, not a template. */
  readonly shared: boolean;
  /** Only useful on a developer machine or in tests, never in a deploy. */
  readonly devOnly: boolean;
}

const EXAMPLE_SUFFIXES: readonly string[] = ['example', 'sample', 'dist'];
const TEMPLATE_SUFFIXES: readonly string[] = ['template'];

const segments = (relativePath: string): string[] =>
  relativePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

/** Classifies a dotenv file by its name: the whole naming convention lives here. */
export function classifyEnvFile(
  relativePath: string,
  extraExampleFiles: readonly string[] = [],
): EnvFileClassification {
  const parts = segments(relativePath);
  const name = parts[parts.length - 1] ?? '';
  const tokens = name
    .replace(/\.env$/, '.')
    .replace(/^\.env\./, '')
    .split(/[.\-_]/)
    .filter((token) => token.length > 0);

  const isExample = (suffix: string): boolean => tokens.includes(suffix);
  const isLocal = name.endsWith('.local') || name.startsWith('.env.local') || name.includes('.local.');
  const isTest = isExample('test') || isExample('testing') || isExample('e2e');
  const isProduction = isExample('prod') || isExample('production') || isExample('live');
  const isDevelopment = isExample('dev') || isExample('develop') || isExample('development') || isExample('local');
  const isCi = isExample('ci') || isExample('staging') || isExample('preview');

  let kind: EnvFileKind = 'dev';
  if (EXAMPLE_SUFFIXES.some((suffix) => isExample(suffix))) {
    kind = 'example';
  } else if (TEMPLATE_SUFFIXES.some((suffix) => isExample(suffix))) {
    kind = 'template';
  } else if (isLocal) {
    kind = 'local';
  } else if (isTest) {
    kind = 'test';
  } else if (isCi) {
    kind = 'test';
  } else if (isProduction) {
    kind = 'production';
  } else if (isDevelopment) {
    kind = 'dev';
  } else if (
    extraExampleFiles.some((glob) => matchGlob(name, glob, true) || matchGlob(relativePath, glob, true))
  ) {
    kind = 'example';
  }

  const shared = kind !== 'local' && kind !== 'example' && kind !== 'template';
  const devOnly = kind === 'local' || kind === 'test';
  return { kind, shared, devOnly };
}
