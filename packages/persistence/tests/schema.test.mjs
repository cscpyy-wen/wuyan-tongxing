import assert from "node:assert/strict";
import test from "node:test";
import { initializePgliteSchema, PGLITE_SCHEMA_SQL } from "../src/index.js";

test("shared schema initialization is reusable and fully idempotent", async () => {
  const calls = [];
  const executor = { exec: async (sql) => { calls.push(sql); } };

  await initializePgliteSchema(executor);
  await initializePgliteSchema(executor);

  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  for (const table of [
    "consents", "subject_entities", "sync_mutations", "provider_targets",
    "reminder_intents", "telemetry_events", "content_releases", "jobs",
    "audit_log", "admin_working_copies"
  ]) {
    assert.match(PGLITE_SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.doesNotMatch(PGLITE_SCHEMA_SQL, /CREATE TABLE (?!IF NOT EXISTS)/);
  assert.doesNotMatch(PGLITE_SCHEMA_SQL, /CREATE INDEX (?!IF NOT EXISTS)/);
  assert.match(PGLITE_SCHEMA_SQL, /DROP CONSTRAINT IF EXISTS sync_mutations_mutation_id_key/);
  assert.match(PGLITE_SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS sync_owner_mutation_idx ON sync_mutations\(subject_id, mutation_id\)/);
  assert.match(PGLITE_SCHEMA_SQL, /ALTER TABLE sync_mutations ADD COLUMN IF NOT EXISTS request_fingerprint text/);
  assert.match(PGLITE_SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS reminders_owner_receipt_idx/);
  assert.match(PGLITE_SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS reminders_owner_idempotency_idx/);
  assert.match(PGLITE_SCHEMA_SQL, /ALTER TABLE reminder_intents ADD COLUMN IF NOT EXISTS idempotency_key text/);
  assert.match(PGLITE_SCHEMA_SQL, /ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS phase text/);
});
