export interface SqlSchemaExecutor {
  exec(sql: string): Promise<unknown>;
}

export declare const PGLITE_SCHEMA_SQL: string;
export declare function initializePgliteSchema(executor: SqlSchemaExecutor): Promise<void>;
