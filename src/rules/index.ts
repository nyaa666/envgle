import type { Rule, RuleId, Severity } from '../types.js';
import { contractRules } from './contract.js';
import { hygieneRules } from './hygiene.js';
import { securityRules } from './security.js';

/** Every rule the engine can run, ordered contract, hygiene, security. */
export const allRules: readonly Rule[] = [...contractRules, ...hygieneRules, ...securityRules];

const rulesById = new Map<RuleId, Rule>(allRules.map((rule) => [rule.id, rule]));
const knownRuleIds = new Set<string>(allRules.map((rule) => rule.id));

const byId = (a: Rule, b: Rule): number => compareId(a.id, b.id);

/** Returns the rule definition for an id, or undefined when the id is not implemented. */
export function getRule(id: RuleId): Rule | undefined {
  return rulesById.get(id);
}

/** Rules whose default severity equals the given severity, sorted by id. */
export function rulesBySeverity(severity: Severity): readonly Rule[] {
  return allRules.filter((rule) => rule.severity === severity).sort(byId);
}

/** Type guard narrowing an arbitrary string to a known rule id. */
export function isKnownRule(id: string): id is RuleId {
  return knownRuleIds.has(id);
}

/** Every known rule id, sorted. */
export function ruleIds(): readonly RuleId[] {
  return allRules.map((rule) => rule.id).sort(compareId);
}

function compareId(a: RuleId, b: RuleId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
