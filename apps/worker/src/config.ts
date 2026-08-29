import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export interface WorkerConfig {
  databaseDir: string;
  nodeEnv: "development" | "test" | "production";
  encryptionKey: string;
  wechatAppId: string;
  wechatAppSecret: string;
  wechatTemplateId: string;
  pollIntervalMs: number;
}

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const environmentFile = resolve(workspaceRoot, ".env");
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

const value = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

function nodeEnvironment(raw: string): WorkerConfig["nodeEnv"] {
  if (raw === "development" || raw === "test" || raw === "production") return raw;
  throw new Error("NODE_ENV must be one of development, test, or production");
}

function isBase64Key(raw: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === bytes && decoded.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "");
}

export function loadWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const rawEnv = value("NODE_ENV", "development");
  const rawDatabaseDir = value("DATABASE_DIR", "./data/pglite");
  const config: WorkerConfig = {
    databaseDir: rawDatabaseDir === "memory://" ? rawDatabaseDir : resolve(workspaceRoot, rawDatabaseDir),
    nodeEnv: nodeEnvironment(rawEnv),
    encryptionKey: value("DEV_DATA_ENCRYPTION_KEY", "development-only-encryption-key-change-me"),
    wechatAppId: value("WECHAT_APP_ID"),
    wechatAppSecret: value("WECHAT_APP_SECRET"),
    wechatTemplateId: value("WECHAT_SUBSCRIBE_TEMPLATE_ID"),
    pollIntervalMs: Number(value("WORKER_POLL_INTERVAL_MS", "3000")),
    ...overrides
  };

  nodeEnvironment(config.nodeEnv);

  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 100 || config.pollIntervalMs > 60_000) {
    throw new Error("WORKER_POLL_INTERVAL_MS must be an integer between 100 and 60000");
  }
  if (Boolean(config.wechatAppId) !== Boolean(config.wechatAppSecret)) {
    throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET must be configured together");
  }
  if ((config.wechatAppId || config.wechatAppSecret) && !config.wechatTemplateId) {
    throw new Error("WECHAT_SUBSCRIBE_TEMPLATE_ID is required when WeChat delivery is enabled");
  }
  if (config.nodeEnv === "production") {
    const missing = [
      ["DEV_DATA_ENCRYPTION_KEY", config.encryptionKey]
    ].filter(([, entry]) => !entry || entry.includes("development") || entry.includes("replace"));
    if (missing.length > 0) {
      throw new Error(`Unsafe production configuration: ${missing.map(([name]) => name).join(", ")}`);
    }
    if (!isBase64Key(config.encryptionKey, 32)) {
      throw new Error("DEV_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key in production");
    }
    throw new Error("Embedded PGlite is restricted to local/internal testing; a PostgreSQL production adapter is required");
  }
  return config;
}
