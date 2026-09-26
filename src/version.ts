export const VERSION = '0.1.0';

export const REPO_URL = 'https://github.com/nyaa666/envgle';

export const DOCS_BASE_URL = `${REPO_URL}/blob/main/docs`;

export function ruleDocsUrl(ruleId: string): string {
  return `${DOCS_BASE_URL}/rules.md#${ruleId}`;
}

export function ruleDocsAnchor(ruleId: string): string {
  return `docs/rules.md#${ruleId}`;
}
