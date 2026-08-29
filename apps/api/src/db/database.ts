import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite, type Results } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { initializePgliteSchema } from "@wuyan/persistence";
import { schema } from "./schema.js";

export class Database {
  readonly engine = "pglite" as const;
  readonly pg: PGlite;
  readonly orm: PgliteDatabase<typeof schema>;

  private constructor(pg: PGlite) {
    this.pg = pg;
    this.orm = drizzle(pg, { schema });
  }

  static async open(path: string): Promise<Database> {
    if (path !== "memory://") await mkdir(dirname(path), { recursive: true });
    const pg = new PGlite(path);
    await initializePgliteSchema(pg);
    return new Database(pg);
  }

  query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    return this.pg.query<T>(sql, params);
  }

  async assertReady(): Promise<void> {
    const tables = await this.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN (
         'consents','subject_entities','sync_mutations','provider_targets','reminder_intents',
         'telemetry_events','content_releases','jobs','audit_log','admin_working_copies'
       )`
    );
    if (tables.rows[0]?.count !== 10) throw new Error("Database schema is incomplete");
    const columns = await this.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
       WHERE table_schema='public' AND (
         (table_name='sync_mutations' AND column_name='request_fingerprint') OR
         (table_name='telemetry_events' AND column_name='phase') OR
         (table_name='reminder_intents' AND column_name='idempotency_key')
       )`
    );
    if (columns.rows[0]?.count !== 3) throw new Error("Database schema migration is incomplete");
    const indexes = await this.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname='public'
       AND indexname IN ('sync_owner_mutation_idx','reminders_owner_receipt_idx','reminders_owner_idempotency_idx')`
    );
    if (indexes.rows[0]?.count !== 3) throw new Error("Database uniqueness safeguards are incomplete");
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
