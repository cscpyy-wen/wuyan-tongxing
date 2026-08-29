import { describe, expect, it } from "vitest";
import { loadWorkerConfig, type WorkerConfig } from "../src/config.js";

const validProduction: WorkerConfig = {
  databaseDir: "memory://",
  nodeEnv: "production",
  encryptionKey: Buffer.alloc(32, 5).toString("base64"),
  wechatAppId: "",
  wechatAppSecret: "",
  wechatTemplateId: "",
  pollIntervalMs: 3_000
};

describe("worker production safeguards", () => {
  it("fails closed on development placeholder secrets", () => {
    expect(() => loadWorkerConfig({ nodeEnv: "production" })).toThrow("Unsafe production configuration");
  });

  it("enforces encryption-key strength in production without loading the API token secret", () => {
    expect(() => loadWorkerConfig({ ...validProduction, encryptionKey: Buffer.alloc(16).toString("base64") }))
      .toThrow("DEV_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    expect(() => loadWorkerConfig(validProduction)).toThrow("PostgreSQL production adapter");
  });

  it("requires a complete WeChat delivery configuration", () => {
    expect(() => loadWorkerConfig({ ...validProduction, nodeEnv: "test", wechatAppId: "app-only" }))
      .toThrow("must be configured together");
    expect(() => loadWorkerConfig({ ...validProduction, nodeEnv: "test", wechatAppId: "app", wechatAppSecret: "secret" }))
      .toThrow("WECHAT_SUBSCRIBE_TEMPLATE_ID");
  });

  it("rejects unsafe polling intervals", () => {
    expect(() => loadWorkerConfig({ pollIntervalMs: 0 })).toThrow("WORKER_POLL_INTERVAL_MS");
    expect(() => loadWorkerConfig({ pollIntervalMs: Number.NaN })).toThrow("WORKER_POLL_INTERVAL_MS");
  });

  it("fails closed on an unknown environment", () => {
    expect(() => loadWorkerConfig({ nodeEnv: "staging" as never })).toThrow("NODE_ENV");
  });
});
