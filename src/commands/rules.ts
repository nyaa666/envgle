import { allRules, getRule } from '../rules/index.js';
import { ruleDocsUrl } from '../version.js';
import { stableStringify } from '../utils/text.js';
import type { CommandContext, CommandOutcome } from './context.js';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function runRulesCommand(context: CommandContext): CommandOutcome {
  if (context.switches.has('--json') || context.format === 'json') {
    const payload = {
      tool: 'envgle',
      count: allRules.length,
      rules: [...allRules]
        .sort((a, b) => byCodeUnit(a.id, b.id))
        .map((rule) => ({
          id: rule.id,
          title: rule.title,
          severity: rule.severity,
          tags: rule.tags,
          description: rule.description,
          remediation: rule.remediation,
          docs: rule.docs,
          docsUrl: ruleDocsUrl(rule.id),
        })),
    };
    context.io.stdout(`${stableStringify(payload)}\n`);
    return { exitCode: 0 };
  }

  const rules = [...allRules].sort((a, b) => {
    const weight = { error: 0, warn: 1, info: 2 } as const;
    return weight[a.severity] - weight[b.severity] || byCodeUnit(a.id, b.id);
  });
  const width = Math.max(...rules.map((rule) => rule.id.length));
  for (const rule of rules) {
    const category = rule.tags[0] ?? 'general';
    context.io.stdout(`${rule.severity.padEnd(5)}  ${rule.id.padEnd(width)}  ${category.padEnd(12)}  ${rule.title}\n`);
  }
  const counts: Record<'error' | 'warn' | 'info', number> = { error: 0, warn: 0, info: 0 };
  for (const rule of allRules) {
    counts[rule.severity] += 1;
  }
  context.io.stdout(
    `\n${allRules.length} rules: ${counts.error} error, ${counts.warn} warn, ${counts.info} info\n`,
  );
  context.io.stderr(`docs: ${ruleDocsUrl('missing-in-env')}\n`);
  return { exitCode: 0 };
}

export function describeRule(id: string): string | null {
  const rule = getRule(id as never);
  return rule === undefined ? null : `${rule.severity} ${rule.id} ${rule.title}`;
}
