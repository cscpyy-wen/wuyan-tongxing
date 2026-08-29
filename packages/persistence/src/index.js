/**
 * The local PGlite schema is shared by the API and the serial internal worker.
 * Every statement is idempotent so either entry point can safely initialize a
 * fresh local database without maintaining a second schema copy.
 */
export const PGLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS consents (
  subject_id text NOT NULL, purpose text NOT NULL, version text NOT NULL,
  granted boolean NOT NULL, decided_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (subject_id, purpose)
);
CREATE TABLE IF NOT EXISTS subject_entities (
  subject_id text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  revision integer NOT NULL, payload jsonb, deleted boolean NOT NULL DEFAULT false,
  client_updated_at timestamptz NOT NULL, server_updated_at timestamptz NOT NULL,
  PRIMARY KEY (subject_id, entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS sync_mutations (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, mutation_id uuid NOT NULL,
  subject_id text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL,
  operation text NOT NULL, revision integer NOT NULL, payload jsonb,
  client_updated_at timestamptz NOT NULL, server_updated_at timestamptz NOT NULL,
  request_fingerprint text
);
ALTER TABLE sync_mutations ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE sync_mutations DROP CONSTRAINT IF EXISTS sync_mutations_mutation_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS sync_owner_mutation_idx ON sync_mutations(subject_id, mutation_id);
CREATE INDEX IF NOT EXISTS sync_owner_sequence_idx ON sync_mutations(subject_id, sequence);
CREATE TABLE IF NOT EXISTS provider_targets (
  subject_id text PRIMARY KEY, provider text NOT NULL, encrypted_target text NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS reminder_intents (
  id uuid PRIMARY KEY, subject_id text NOT NULL, kind text NOT NULL,
  scheduled_at timestamptz NOT NULL, template_id text, grant_receipt text, idempotency_key text,
  status text NOT NULL, delivery_mode text NOT NULL, created_at timestamptz NOT NULL
);
ALTER TABLE reminder_intents ADD COLUMN IF NOT EXISTS idempotency_key text;
UPDATE reminder_intents SET idempotency_key=grant_receipt WHERE idempotency_key IS NULL;
CREATE INDEX IF NOT EXISTS reminders_owner_idx ON reminder_intents(subject_id);
CREATE UNIQUE INDEX IF NOT EXISTS reminders_owner_receipt_idx
  ON reminder_intents(subject_id, grant_receipt) WHERE grant_receipt IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reminders_owner_idempotency_idx
  ON reminder_intents(subject_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS telemetry_events (
  id uuid PRIMARY KEY, analytics_id uuid NOT NULL, name text NOT NULL,
  phase text, properties jsonb NOT NULL, occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS phase text;
CREATE INDEX IF NOT EXISTS telemetry_expiry_idx ON telemetry_events(expires_at);
CREATE TABLE IF NOT EXISTS content_releases (
  id uuid PRIMARY KEY, release_number integer NOT NULL UNIQUE, channel text NOT NULL,
  content_version text NOT NULL, rules_version text NOT NULL, snapshot jsonb NOT NULL,
  note text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL,
  rolled_back_from uuid
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL,
  locked_at timestamptz, last_error text, created_at timestamptz NOT NULL, completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(status, available_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
  metadata jsonb NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_working_copies (
  kind text PRIMARY KEY, data jsonb NOT NULL, updated_by text NOT NULL, updated_at timestamptz NOT NULL
);
`;

/** @param {{ exec(sql: string): Promise<unknown> }} executor */
export async function initializePgliteSchema(executor) {
  await executor.exec(PGLITE_SCHEMA_SQL);
}
