import * as contentModule from "@wuyan/content";
import * as rulesModule from "@wuyan/rules";

type JsonRecord = Record<string, unknown>;

const content = contentModule as unknown as JsonRecord;
const rules = rulesModule as unknown as JsonRecord;

function arrayValue(...values: unknown[]): unknown[] {
  return values.find(Array.isArray) as unknown[] | undefined ?? [];
}

function nested(source: unknown, key: string): unknown {
  return source && typeof source === "object" ? (source as JsonRecord)[key] : undefined;
}

export function contentVersion(): string {
  const bundle = content.contentBundle;
  const version = content.CONTENT_VERSION ?? nested(bundle, "version");
  return typeof version === "string" ? version : "internal-draft-0";
}

export function contentItems(): unknown[] {
  return arrayValue(content.CONTENT_ITEMS, nested(content.contentBundle, "items"), nested(content.contentBundle, "content"));
}

export function evidenceCatalog(): unknown[] {
  return arrayValue(content.EVIDENCE_CATALOG, content.evidenceSources, nested(content.contentBundle, "evidence"));
}

export function claimMatrix(): unknown[] {
  return arrayValue(content.CLAIM_MATRIX, nested(content.contentBundle, "claims"));
}

export function ruleDefinitions(): unknown[] {
  return arrayValue(rules.defaultRules, rules.DEFAULT_RULES);
}

export function ruleVersion(): string {
  const candidate = rules.DEFAULT_RULESET_VERSION ?? nested(rules.defaultRules, "version");
  return typeof candidate === "string" ? candidate : contentVersion();
}

export function publicBootstrap(): JsonRecord {
  const getter = content.getContentBootstrap;
  if (typeof getter === "function") {
    const generated = getter();
    if (generated && typeof generated === "object") {
      return {
        ...(generated as JsonRecord),
        version: contentVersion(),
        rules: ruleDefinitions(),
        resources: arrayValue(nested(content.contentBundle, "resources")),
        status: "draft",
        channel: "internal",
        banner: "循证草案，待医学审核"
      };
    }
  }
  return {
    version: contentVersion(),
    status: "draft",
    channel: "internal",
    banner: "循证草案，待医学审核",
    content: contentItems(),
    rules: ruleDefinitions(),
    resources: arrayValue(nested(content.contentBundle, "resources"))
  };
}

export function validateRuleDefinitions(input: unknown): { success: boolean; issues: string[] } {
  if (!Array.isArray(input)) return { success: false, issues: ["rules 必须是数组"] };
  const serialized = JSON.stringify(input);
  if (/\b(function|eval|script|javascript|code)\b/i.test(serialized)) {
    return { success: false, issues: ["规则只能使用白名单 JSON，不允许脚本或自由代码"] };
  }
  const schema = rules.RuleDefinitionSchema as { safeParse?: (value: unknown) => { success: boolean; error?: { issues?: Array<{ message: string }> } } } | undefined;
  if (!schema?.safeParse) {
    return { success: false, issues: ["规则白名单校验器不可用"] };
  }
  const issues: string[] = [];
  for (const [index, item] of input.entries()) {
    const result = schema.safeParse(item);
    if (!result.success) issues.push(...(result.error?.issues ?? []).map((issue) => `规则 ${index + 1}: ${issue.message}`));
  }
  return { success: issues.length === 0, issues };
}
