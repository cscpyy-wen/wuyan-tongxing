import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const consents = pgTable("consents", {
  subjectId: text("subject_id").notNull(),
  purpose: text("purpose").notNull(),
  version: text("version").notNull(),
  granted: boolean("granted").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("consents_subject_purpose_idx").on(table.subjectId, table.purpose)]);

export const subjectEntities = pgTable("subject_entities", {
  subjectId: text("subject_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  revision: integer("revision").notNull(),
  payload: jsonb("payload"),
  deleted: boolean("deleted").notNull().default(false),
  clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }).notNull(),
  serverUpdatedAt: timestamp("server_updated_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("subject_entity_owner_idx").on(table.subjectId, table.entityType, table.entityId)]);

export const syncMutations = pgTable("sync_mutations", {
  sequence: bigint("sequence", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  mutationId: uuid("mutation_id").notNull(),
  subjectId: text("subject_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  operation: text("operation").notNull(),
  revision: integer("revision").notNull(),
  payload: jsonb("payload"),
  requestFingerprint: text("request_fingerprint"),
  clientUpdatedAt: timestamp("client_updated_at", { withTimezone: true }).notNull(),
  serverUpdatedAt: timestamp("server_updated_at", { withTimezone: true }).notNull()
}, (table) => [
  uniqueIndex("sync_owner_mutation_idx").on(table.subjectId, table.mutationId),
  index("sync_owner_sequence_idx").on(table.subjectId, table.sequence)
]);

export const providerTargets = pgTable("provider_targets", {
  subjectId: text("subject_id").primaryKey(),
  provider: text("provider").notNull(),
  encryptedTarget: text("encrypted_target").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const reminderIntents = pgTable("reminder_intents", {
  id: uuid("id").primaryKey(),
  subjectId: text("subject_id").notNull(),
  kind: text("kind").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  templateId: text("template_id"),
  grantReceipt: text("grant_receipt"),
  idempotencyKey: text("idempotency_key"),
  status: text("status").notNull(),
  deliveryMode: text("delivery_mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [
  index("reminders_owner_idx").on(table.subjectId),
  uniqueIndex("reminders_owner_receipt_idx").on(table.subjectId, table.grantReceipt),
  uniqueIndex("reminders_owner_idempotency_idx").on(table.subjectId, table.idempotencyKey)
]);

export const telemetryEvents = pgTable("telemetry_events", {
  id: uuid("id").primaryKey(),
  analyticsId: uuid("analytics_id").notNull(),
  name: text("name").notNull(),
  phase: text("phase"),
  properties: jsonb("properties").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
}, (table) => [index("telemetry_expiry_idx").on(table.expiresAt)]);

export const contentReleases = pgTable("content_releases", {
  id: uuid("id").primaryKey(),
  releaseNumber: integer("release_number").notNull().unique(),
  channel: text("channel").notNull(),
  contentVersion: text("content_version").notNull(),
  rulesVersion: text("rules_version").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  note: text("note").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  rolledBackFrom: uuid("rolled_back_from")
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true })
}, (table) => [index("jobs_ready_idx").on(table.status, table.availableAt)]);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  metadata: jsonb("metadata").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull()
});

export const adminWorkingCopies = pgTable("admin_working_copies", {
  kind: text("kind").primaryKey(),
  data: jsonb("data").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const schema = {
  consents,
  subjectEntities,
  syncMutations,
  providerTargets,
  reminderIntents,
  telemetryEvents,
  contentReleases,
  jobs,
  auditLog,
  adminWorkingCopies
};
