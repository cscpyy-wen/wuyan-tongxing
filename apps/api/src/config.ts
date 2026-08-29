import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  adminOrigin: string;
  clientOrigin: string;
  databaseDir: string;
  tokenSecret: string;
  identifierSecret: string;
  encryptionKey: string;
  adminEmail: string;
  adminPassword: string;
  wechatAppId: string;
  wechatAppSecret: string;
  wechatTemplateId: string;
  trustProxy: false | string[];
}

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const environmentFile = resolve(workspaceRoot, ".env");
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

const value = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

function nodeEnvironment(raw: string): AppConfig["nodeEnv"] {
  if (raw === "development" || raw === "test" || raw === "production") return raw;
  throw new Error("NODE_ENV must be one of development, test, or production");
}

function trustedProxies(raw: string): AppConfig["trustProxy"] {
  if (!raw || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") {
    throw new Error("API_TRUST_PROXY must list trusted proxy addresses or CIDRs; true is not allowed");
  }
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("API_TRUST_PROXY must be false or a comma-separated proxy allowlist");
  return entries;
}

function webOrigin(name: string, raw: string, production: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an absolute HTTP(S) origin without credentials, path, query, or fragment`);
  }
  if (production && parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production`);
  return parsed.origin;
}

function isBase64Key(raw: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === bytes && decoded.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "");
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const rawEnv = value("NODE_ENV", "development");
  const rawDatabaseDir = value("DATABASE_DIR", "./data/pglite");
  const config: AppConfig = {
    nodeEnv: nodeEnvironment(rawEnv),
    host: value("API_HOST", "127.0.0.1"),
    port: Number(value("API_PORT", "4310")),
    adminOrigin: value("ADMIN_ORIGIN", "http://127.0.0.1:4311"),
    clientOrigin: value("CLIENT_ORIGIN", "http://127.0.0.1:4173"),
    databaseDir: rawDatabaseDir === "memory://" ? rawDatabaseDir : resolve(workspaceRoot, rawDatabaseDir),
    tokenSecret: value("TOKEN_SECRET", "development-only-token-secret-change-me"),
    identifierSecret: value("IDENTIFIER_SECRET", "development-only-identifier-secret-change-me"),
    encryptionKey: value("DEV_DATA_ENCRYPTION_KEY", "development-only-encryption-key-change-me"),
    adminEmail: value("ADMIN_EMAIL", "admin@internal.local"),
    adminPassword: value("ADMIN_PASSWORD", "replace-before-use"),
    wechatAppId: value("WECHAT_APP_ID"),
    wechatAppSecret: value("WECHAT_APP_SECRET"),
    wechatTemplateId: value("WECHAT_SUBSCRIBE_TEMPLATE_ID"),
    trustProxy: trustedProxies(value("API_TRUST_PROXY", "false")),
    ...overrides
  };

  nodeEnvironment(config.nodeEnv);

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("API_PORT must be an integer between 1 and 65535");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.adminEmail)) throw new Error("ADMIN_EMAIL must be a valid email address");
  config.adminOrigin = webOrigin("ADMIN_ORIGIN", config.adminOrigin, config.nodeEnv === "production");
  config.clientOrigin = webOrigin("CLIENT_ORIGIN", config.clientOrigin, config.nodeEnv === "production");
  if (Boolean(config.wechatAppId) !== Boolean(config.wechatAppSecret)) {
    throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET must be configured together");
  }
  if (config.nodeEnv === "production") {
    const missing = [
      ["TOKEN_SECRET", config.tokenSecret],
      ["IDENTIFIER_SECRET", config.identifierSecret],
      ["DEV_DATA_ENCRYPTION_KEY", config.encryptionKey],
      ["ADMIN_PASSWORD", config.adminPassword]
    ].filter(([, entry]) => !entry || entry.includes("development") || entry.includes("replace"));
    if (missing.length > 0) {
      throw new Error(`Unsafe production configuration: ${missing.map(([name]) => name).join(", ")}`);
    }
    if (config.tokenSecret.length < 32) throw new Error("TOKEN_SECRET must contain at least 32 characters in production");
    if (config.identifierSecret.length < 32) throw new Error("IDENTIFIER_SECRET must contain at least 32 characters in production");
    if (!isBase64Key(config.encryptionKey, 32)) {
      throw new Error("DEV_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key in production");
    }
    if (config.adminPassword.length < 14) throw new Error("ADMIN_PASSWORD must contain at least 14 characters in production");
    if (safeConfigEqual(config.tokenSecret, config.adminPassword)
      || safeConfigEqual(config.tokenSecret, config.encryptionKey)
      || safeConfigEqual(config.tokenSecret, config.identifierSecret)
      || safeConfigEqual(config.identifierSecret, config.encryptionKey)
      || safeConfigEqual(config.identifierSecret, config.adminPassword)
      || safeConfigEqual(config.adminPassword, config.encryptionKey)) {
      throw new Error("TOKEN_SECRET, IDENTIFIER_SECRET, DEV_DATA_ENCRYPTION_KEY, and ADMIN_PASSWORD must be distinct in production");
    }
    if (config.adminEmail.toLowerCase().endsWith("@internal.local")) throw new Error("ADMIN_EMAIL must be a real controlled address in production");
    if ((config.wechatAppId || config.wechatAppSecret) && !config.wechatTemplateId) {
      throw new Error("WECHAT_SUBSCRIBE_TEMPLATE_ID is required when WeChat delivery is enabled");
    }
    throw new Error("Embedded PGlite is restricted to local/internal testing; a PostgreSQL production adapter is required");
  }
  return config;
}

function safeConfigEqual(left: string, right: string): boolean {
  return left.length === right.length && left === right;
}
