import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(testDir, "..", "src", "data");

function readJson(filename) {
  return JSON.parse(readFileSync(resolve(dataDir, filename), "utf8"));
}

test("content catalog has the accepted category counts", () => {
  const items = readJson("content-items.json");
  const counts = Object.groupBy(items, (item) => item.kind);

  assert.equal(items.length, 73);
  assert.equal(counts.preparation.length, 7);
  assert.equal(counts.daily.length, 28);
  assert.equal(counts.maintenance.length, 4);
  assert.equal(counts.followup.length, 3);
  assert.equal(counts.sos.length, 5);
  assert.equal(counts.lapse_recovery.length, 4);
  assert.equal(counts.medication_referral.length, 6);
  assert.equal(counts.faq.length, 12);
  assert.equal(counts.partner_share.length, 4);
});

test("all evidence references form a closed catalog", () => {
  const items = readJson("content-items.json");
  const evidence = readJson("evidence-sources.json");
  const evidenceIds = new Set(evidence.map((source) => source.id));

  for (const item of items) {
    assert.ok(item.evidenceIds.length > 0, item.id);
    for (const evidenceId of item.evidenceIds) assert.ok(evidenceIds.has(evidenceId), `${item.id}: ${evidenceId}`);
  }
});

test("internal content cannot be mistaken for medically approved content", () => {
  const items = readJson("content-items.json");
  for (const item of items) {
    assert.equal(item.status, "draft", item.id);
    assert.equal(item.channel, "internal", item.id);
    assert.ok(item.riskStatement.length >= 12, item.id);
  }
});

test("referral content does not promise an unavailable city-level directory", () => {
  const items = readJson("content-items.json");
  const referralItems = items.filter((item) => item.id === "prep-07" || item.id === "medication-06");
  assert.equal(referralItems.length, 2);
  const text = JSON.stringify(referralItems);
  assert.doesNotMatch(text, /省市|省和市/);
  assert.match(text, /省级地区/);
  assert.match(text, /不内置城市级门诊名单/);
});

test("the lightweight Today index exactly matches its source content", () => {
  const items = readJson("content-items.json");
  const summaries = readJson("today-content-summaries.json");
  const expected = items
    .filter((item) => ["preparation", "daily", "maintenance"].includes(item.kind))
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.goal || item.body,
      durationMinutes: item.steps.length >= 3 ? 5 : 3,
      sourceLabel: item.mechanisms[0] ?? "循证行为支持",
    }));

  assert.deepEqual(summaries, expected);
});
