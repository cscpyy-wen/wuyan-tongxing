import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const dataDir = resolve(packageDir, "src", "data");

function readJson(filename) {
  return JSON.parse(readFileSync(resolve(dataDir, filename), "utf8"));
}

const items = readJson("content-items.json");
const evidence = readJson("evidence-sources.json");
const claims = readJson("claim-matrix.json");

const expectedIds = [
  ...Array.from({ length: 7 }, (_, index) => `prep-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 28 }, (_, index) => `day-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 4 }, (_, index) => `maintenance-week-${String(index + 5).padStart(2, "0")}`),
  "followup-month-03",
  "followup-month-06",
  "followup-month-12",
  "sos-breathe",
  "sos-surf",
  "sos-change-scene",
  "sos-reasons",
  "sos-partner",
  ...Array.from({ length: 4 }, (_, index) => `lapse-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 6 }, (_, index) => `medication-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `faq-${String(index + 1).padStart(2, "0")}`),
  "share-invite",
  "share-help",
  "share-milestone",
  "share-restart",
];

const expectedCounts = {
  preparation: 7,
  daily: 28,
  maintenance: 4,
  followup: 3,
  sos: 5,
  lapse_recovery: 4,
  medication_referral: 6,
  faq: 12,
  partner_share: 4,
};

const errors = [];

function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}

function duplicateValues(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

requireCondition(Array.isArray(items), "content-items.json 必须是数组");
requireCondition(Array.isArray(evidence), "evidence-sources.json 必须是数组");
requireCondition(Array.isArray(claims), "claim-matrix.json 必须是数组");
requireCondition(items.length === 73, `内容总数应为 73，实际为 ${items.length}`);

const itemIds = items.map((item) => item.id);
requireCondition(duplicateValues(itemIds).length === 0, `内容 ID 重复：${duplicateValues(itemIds).join(", ")}`);

for (const expectedId of expectedIds) {
  requireCondition(itemIds.includes(expectedId), `缺少稳定内容 ID：${expectedId}`);
}
for (const itemId of itemIds) {
  requireCondition(expectedIds.includes(itemId), `存在未约定的内容 ID：${itemId}`);
}

for (const [kind, expectedCount] of Object.entries(expectedCounts)) {
  const actualCount = items.filter((item) => item.kind === kind).length;
  requireCondition(actualCount === expectedCount, `${kind} 应为 ${expectedCount} 项，实际为 ${actualCount}`);
}

const evidenceIds = evidence.map((source) => source.id);
requireCondition(duplicateValues(evidenceIds).length === 0, `证据 ID 重复：${duplicateValues(evidenceIds).join(", ")}`);

const placeholderPattern = /(?:\bTODO\b|\bTBD\b|lorem ipsum|待补充|占位内容|示例文案)/iu;
const prohibitedClaimPatterns = [
  /(?:本产品|本应用|小程序)(?:可以|能够|将)?保证/u,
  /确保(?:你|您)?戒烟成功/u,
  /成功率高达/u,
  /百分之百/u,
  /100%成功/u,
  /治愈(?:烟瘾|尼古丁依赖)/u,
  /自动(?:诊断|开药|处方)/u,
  /最适合你的药/u,
  /点击购买/u,
];

for (const item of items) {
  const prefix = `[${item.id ?? "无 ID"}]`;
  requireCondition(typeof item.id === "string" && item.id.length > 0, `${prefix} 缺少 id`);
  requireCondition(Object.hasOwn(expectedCounts, item.kind), `${prefix} kind 无效：${item.kind}`);
  requireCondition(Number.isInteger(item.order) && item.order > 0, `${prefix} order 必须为正整数`);
  requireCondition(/^\d+\.\d+\.\d+$/.test(item.version), `${prefix} version 必须为 semver`);
  requireCondition(item.status === "draft", `${prefix} status 必须为 draft`);
  requireCondition(item.channel === "internal", `${prefix} channel 必须为 internal`);
  requireCondition(typeof item.title === "string" && item.title.trim().length >= 2, `${prefix} title 为空`);
  requireCondition(typeof item.goal === "string" && item.goal.trim().length >= 8, `${prefix} goal 过短`);
  requireCondition(Array.isArray(item.mechanisms) && item.mechanisms.length > 0, `${prefix} 缺少 BCT/机制`);
  requireCondition(typeof item.body === "string" && item.body.trim().length >= 20, `${prefix} body 过短`);
  requireCondition(Array.from(item.body ?? "").length <= 180, `${prefix} body 超过 180 字符`);
  requireCondition(Array.isArray(item.steps) && item.steps.length >= 2, `${prefix} steps 至少两步`);
  requireCondition(item.steps?.every((step) => typeof step === "string" && step.trim().length >= 4), `${prefix} step 为空或过短`);
  requireCondition(typeof item.action === "string" && item.action.trim().length >= 8, `${prefix} action 过短`);
  requireCondition(typeof item.riskStatement === "string" && item.riskStatement.trim().length >= 12, `${prefix} riskStatement 过短`);
  requireCondition(Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0, `${prefix} 缺少 evidenceIds`);
  for (const evidenceId of item.evidenceIds ?? []) {
    requireCondition(evidenceIds.includes(evidenceId), `${prefix} 引用了不存在的证据：${evidenceId}`);
  }

  const searchableText = JSON.stringify(item);
  requireCondition(!placeholderPattern.test(searchableText), `${prefix} 含占位文本`);
  for (const pattern of prohibitedClaimPatterns) {
    requireCondition(!pattern.test(searchableText), `${prefix} 含禁止宣传或自动医疗表述：${pattern}`);
  }
}

const medicationItems = items.filter((item) => item.kind === "medication_referral");
for (const item of medicationItems) {
  const text = `${item.body} ${item.action} ${item.riskStatement}`;
  requireCondition(/不(?:诊断|开处方|判断|提供|自动|推荐)|咨询|专业/u.test(text), `[${item.id}] 缺少医疗边界`);
  requireCondition(!/\b\d+(?:\.\d+)?\s*(?:mg|毫克|片|粒)\b/iu.test(text), `[${item.id}] 不得包含剂量指令`);
}

for (const source of evidence) {
  const prefix = `[${source.id ?? "无证据 ID"}]`;
  requireCondition(typeof source.id === "string" && source.id.length > 0, `${prefix} 缺少 id`);
  requireCondition(typeof source.title === "string" && source.title.length >= 5, `${prefix} title 过短`);
  requireCondition(typeof source.organization === "string" && source.organization.length >= 2, `${prefix} organization 为空`);
  requireCondition(Number.isInteger(source.year) && source.year >= 2000, `${prefix} year 无效`);
  requireCondition(/^https:\/\//u.test(source.url), `${prefix} URL 必须使用 HTTPS`);
  requireCondition(/^\d{4}-\d{2}-\d{2}$/u.test(source.checkedOn), `${prefix} checkedOn 格式无效`);
  requireCondition(typeof source.limitations === "string" && source.limitations.length >= 12, `${prefix} 缺少证据局限`);
}

const claimIds = claims.map((claim) => claim.id);
requireCondition(duplicateValues(claimIds).length === 0, `主张 ID 重复：${duplicateValues(claimIds).join(", ")}`);
requireCondition(claims.length >= 15, `主张矩阵至少应覆盖 15 项关键主张，实际为 ${claims.length}`);

for (const claim of claims) {
  const prefix = `[${claim.id ?? "无主张 ID"}]`;
  requireCondition(typeof claim.claim === "string" && claim.claim.length >= 12, `${prefix} claim 过短`);
  requireCondition(Array.isArray(claim.evidenceIds) && claim.evidenceIds.length > 0, `${prefix} 缺少证据`);
  requireCondition(Array.isArray(claim.contentIds) && claim.contentIds.length > 0, `${prefix} 缺少关联内容`);
  requireCondition(claim.reviewStatus === "evidence_checked_medical_review_pending", `${prefix} 审核状态必须为待医学审核`);
  requireCondition(typeof claim.wordingBoundary === "string" && claim.wordingBoundary.length >= 12, `${prefix} 缺少表述边界`);
  for (const evidenceId of claim.evidenceIds ?? []) {
    requireCondition(evidenceIds.includes(evidenceId), `${prefix} 引用了不存在的证据：${evidenceId}`);
  }
  for (const contentId of claim.contentIds ?? []) {
    requireCondition(itemIds.includes(contentId), `${prefix} 引用了不存在的内容：${contentId}`);
  }
}

if (errors.length > 0) {
  console.error(`内容校验失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`内容校验通过：${items.length} 项内容，${evidence.length} 条证据，${claims.length} 项关键主张。`);
  console.log("发布状态：draft/internal；循证草案，待具名医学审核。" );
}
