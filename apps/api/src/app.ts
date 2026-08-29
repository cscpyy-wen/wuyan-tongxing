import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  ConsentReceiptSchema,
  ExportRequestSchema,
  ReminderIntentSchema,
  SyncPushRequestSchema,
  TelemetryEventSchema
} from "@wuyan/contracts";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import {
  claimMatrix,
  contentItems,
  contentVersion,
  evidenceCatalog,
  publicBootstrap,
  ruleDefinitions,
  ruleVersion,
  validateRuleDefinitions
} from "./catalog.js";
import { Database } from "./db/database.js";
import {
  decryptSensitiveJson,
  encryptProviderTarget,
  encryptSensitiveJson,
  hashIdentifier,
  issueToken,
  principalFromRequest,
  safeEqual,
  type AuthPrincipal
} from "./security.js";
import {
  AdminReleaseSchema,
  telemetryPropertyAllowlist
} from "./schemas.js";

export const LOG_REDACTION_PATHS = Object.freeze([
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers[\"x-analytics-id\"]",
  "req.body.code",
  "req.body.email",
  "req.body.password",
  "req.body.grantReceipt",
  "req.body.deviceId",
  "req.body.consent",
  "req.body.cloudSyncConsent",
  "req.body.subscriptionGrant",
  "req.body.intent.idempotencyKey",
  "req.body.mutations",
  "req.body.events[*].analyticsId",
  "req.body.events[*].properties",
  "res.headers.set-cookie"
]);

interface BuildOptions {
  config?: Partial<AppConfig>;
  database?: Database;
}

// The intake schema narrows the shared event contract to non-health, aggregation-safe properties.
const TelemetryIntakeEventSchema = TelemetryEventSchema.extend({
  properties: z.object({
    page: z.enum(["onboarding", "today", "record", "progress", "mine", "sos", "content", "medication", "referral", "follow_up"]).optional(),
    source: z.enum(["app_launch", "tab", "today_task", "sos", "follow_up", "notification", "share_return", "unknown"]).optional(),
    result: z.enum(["completed", "dismissed", "failed", "unknown"]).optional(),
    durationBucket: z.enum(["under_30s", "30s_2m", "2m_5m", "over_5m"]).optional(),
    dayBucket: z.enum(["prepare", "day_1_7", "day_8_28", "week_5_8", "month_3_12"]).optional(),
    path: z.enum(["direct", "reduction", "unknown"]).optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(40).optional()
  }).strict()
});

const bearerSecurity = [{ bearerAuth: [] }];
const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60_000;

function isFutureClientTime(value: string): boolean {
  return new Date(value).getTime() > Date.now() + MAX_CLIENT_CLOCK_SKEW_MS;
}

function containsFutureTimestamp(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsFutureTimestamp);
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    (key.endsWith("At") && typeof entry === "string" && isFutureClientTime(entry)) || containsFutureTimestamp(entry)
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function syncFingerprint(mutation: {
  objectId: string;
  objectType: string;
  operation: string;
  objectVersion: number;
  payload: unknown;
  clientChangedAt: string;
}, secret: string): string {
  return hashIdentifier(`sync-mutation-v1:${canonicalJson(mutation)}`, secret);
}

const unauthorized = (reply: FastifyReply, request: FastifyRequest, code = "UNAUTHORIZED", message = "身份凭证无效或已过期") =>
  reply.code(401).send({ error: { code, message, requestId: request.id } });

const forbidden = (reply: FastifyReply, request: FastifyRequest, code: string, message: string) =>
  reply.code(403).send({ error: { code, message, requestId: request.id } });

function authorize(request: FastifyRequest, reply: FastifyReply, config: AppConfig, kind: "user" | "admin"): AuthPrincipal | null {
  const principal = principalFromRequest(request, config);
  if (!principal) {
    void unauthorized(reply, request);
    return null;
  }
  if (principal.kind !== kind) {
    void forbidden(reply, request, "ROLE_FORBIDDEN", "当前身份不能执行此操作");
    return null;
  }
  return principal;
}

async function hasConsent(database: Database, subjectId: string, purpose: string): Promise<boolean> {
  const result = await database.query<{ granted: boolean }>(
    "SELECT granted FROM consents WHERE subject_id = $1 AND purpose = $2",
    [subjectId, purpose]
  );
  return result.rows[0]?.granted === true;
}

async function requireConsent(
  database: Database,
  subjectId: string,
  purpose: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (await hasConsent(database, subjectId, purpose)) return true;
  await forbidden(reply, request, "CONSENT_REQUIRED", `需要先明确同意 ${purpose}；拒绝不会影响本地功能`);
  return false;
}

function validateContentWorkingCopy(value: unknown): { success: boolean; issues: string[] } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return { success: false, issues: ["内容必须是 1–500 项的数组"] };
  const issues: string[] = [];
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") { issues.push(`第 ${index + 1} 项不是对象`); return; }
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) issues.push(`第 ${index + 1} 项 ID 无效`);
    else if (ids.has(item.id)) issues.push(`内容 ID 重复：${item.id}`); else ids.add(item.id);
    for (const field of ["kind", "title", "goal", "body", "action", "riskStatement"]) {
      if (typeof item[field] !== "string" || !(item[field] as string).trim()) issues.push(`${item.id || `第 ${index + 1} 项`} 缺少 ${field}`);
    }
    if (!Array.isArray(item.steps) || !Array.isArray(item.evidenceIds)) issues.push(`${item.id || `第 ${index + 1} 项`} 的 steps/evidenceIds 必须是数组`);
    if (item.status !== "draft" || item.channel !== "internal") issues.push(`${item.id || `第 ${index + 1} 项`} 只能保持 draft/internal`);
  });
  return { success: issues.length === 0, issues };
}

async function workingCopy(database: Database, kind: "content" | "rules", fallback: unknown[]): Promise<unknown[]> {
  const result = await database.query<{ data: unknown }>("SELECT data FROM admin_working_copies WHERE kind=$1", [kind]);
  return Array.isArray(result.rows[0]?.data) ? result.rows[0].data : fallback;
}

function validateRuleLinks(definitions: unknown[], items: unknown[]): string[] {
  const contentIds = new Set(items.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).id : null).filter((id): id is string => typeof id === "string"));
  const evidenceIds = new Set(evidenceCatalog().map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).id : null).filter((id): id is string => typeof id === "string"));
  const issues: string[] = [];
  definitions.forEach((entry, index) => {
    const decision = entry && typeof entry === "object" ? (entry as Record<string, unknown>).decision : null;
    if (!decision || typeof decision !== "object") return;
    const contentId = (decision as Record<string, unknown>).contentId;
    if (typeof contentId === "string" && !contentIds.has(contentId)) issues.push(`规则 ${index + 1} 引用了不存在的内容 ${contentId}`);
    const refs = (decision as Record<string, unknown>).evidenceSourceIds;
    if (Array.isArray(refs)) for (const ref of refs) if (typeof ref === "string" && !evidenceIds.has(ref)) issues.push(`规则 ${index + 1} 引用了不存在的证据 ${ref}`);
  });
  return issues;
}

export async function buildApp(options: BuildOptions = {}) {
  const config = loadConfig(options.config);
  const database = options.database ?? await Database.open(config.databaseDir);
  const app = Fastify({
    logger: config.nodeEnv === "test" ? false : {
      level: config.nodeEnv === "production" ? "info" : "debug",
      redact: {
        paths: [...LOG_REDACTION_PATHS],
        censor: "[REDACTED]"
      }
    },
    bodyLimit: 512 * 1024,
    trustProxy: config.trustProxy
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      info: { title: "无烟同行内部 API", version: "0.1.0" },
      servers: [{ url: "/", description: "当前 API 实例" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "HMAC-SHA256" }
        }
      },
      tags: [
        { name: "public", description: "无需账号的启动内容" },
        { name: "auth", description: "身份交换；mock 仅限非生产环境" },
        { name: "sync", description: "明确同意后的用户自有数据同步" },
        { name: "admin", description: "仅内容与规则管理，不暴露个人记录" }
      ]
    },
    transform: jsonSchemaTransform
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || [config.adminOrigin, config.clientOrigin].includes(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Analytics-Id"]
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCandidate = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 500;
    const statusCode = Number.isInteger(statusCandidate) && statusCandidate >= 400 ? statusCandidate : 500;
    request.log.warn({ errorName: error instanceof Error ? error.name : "UnknownError", statusCode, requestId: request.id }, "request failed");
    const errorMessage = error instanceof Error ? error.message : "请求无效";
    const message = statusCode >= 500 ? "服务暂时不可用" : errorMessage;
    return reply.code(statusCode).send({
      error: { code: statusCode >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST", message, requestId: request.id }
    });
  });

  app.get("/health", { schema: { hide: true } }, async (request, reply) => {
    try {
      await database.assertReady();
      return { status: "ok", database: database.engine };
    } catch (error) {
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "database readiness probe failed");
      return reply.code(503).send({ status: "unavailable", database: database.engine });
    }
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.get("/v1/bootstrap", {
    schema: { tags: ["public"], summary: "获取离线启动内容、规则和内部草案标识" }
  }, async () => publicBootstrap());

  app.post("/v1/auth/mock", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      tags: ["auth"],
      summary: "开发环境模拟身份；生产环境不可用",
      body: z.object({ deviceId: z.uuid() })
    }
  }, async (request, reply) => {
    if (config.nodeEnv === "production") {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "接口不存在", requestId: request.id } });
    }
    const subject = `mock_${hashIdentifier(`mock-subject-v1:${request.body.deviceId}`, config.identifierSecret)}`;
    return { accessToken: issueToken({ kind: "user", sub: subject }, config.tokenSecret, 24 * 3_600), expiresIn: 86_400, mode: "mock" };
  });

  app.post("/v1/auth/wechat", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      tags: ["auth"],
      summary: "在明确开启云同步时使用临时 code 交换微信身份；服务端不会返回或记录明文 OpenID",
      body: z.object({
        code: z.string().min(6).max(256),
        cloudSyncConsent: ConsentReceiptSchema
      }).strict().superRefine((value, context) => {
        if (value.cloudSyncConsent.scope !== "CLOUD_SYNC" || !value.cloudSyncConsent.granted) {
          context.addIssue({ code: "custom", path: ["cloudSyncConsent"], message: "微信身份交换必须随明确的云同步同意提交" });
        }
      })
    }
  }, async (request, reply) => {
    if (isFutureClientTime(request.body.cloudSyncConsent.recordedAt)) {
      return reply.code(422).send({ error: { code: "CLIENT_TIME_IN_FUTURE", message: "同意时间超出允许的设备时钟偏差", requestId: request.id } });
    }
    if (!config.wechatAppId || !config.wechatAppSecret) {
      return reply.code(503).send({ error: { code: "WECHAT_NOT_CONFIGURED", message: "尚未配置正式 AppID；请使用 mock 适配器", requestId: request.id } });
    }
    const endpoint = new URL("https://api.weixin.qq.com/sns/jscode2session");
    endpoint.searchParams.set("appid", config.wechatAppId);
    endpoint.searchParams.set("secret", config.wechatAppSecret);
    endpoint.searchParams.set("js_code", request.body.code);
    endpoint.searchParams.set("grant_type", "authorization_code");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { openid?: string; errcode?: number };
    if (!response.ok || !body.openid || body.errcode) {
      return reply.code(401).send({ error: { code: "WECHAT_EXCHANGE_FAILED", message: "微信身份交换失败，请重新进入小程序", requestId: request.id } });
    }
    const openId = body.openid;
    const subject = `wx_${hashIdentifier(`wechat-subject-v1:${openId}`, config.identifierSecret)}`;
    const linked = await database.pg.transaction(async (tx) => {
      const receipt = request.body.cloudSyncConsent;
      const saved = await tx.query<{ granted: boolean }>(
        `INSERT INTO consents(subject_id,purpose,version,granted,decided_at,updated_at)
         VALUES ($1,'cloud_sync',$2,true,$3,now())
         ON CONFLICT(subject_id,purpose) DO UPDATE SET version=EXCLUDED.version,granted=true,
           decided_at=EXCLUDED.decided_at,updated_at=now()
         WHERE consents.decided_at < EXCLUDED.decided_at
         RETURNING granted`,
        [subject, receipt.policyVersion, receipt.recordedAt]
      );
      if (!saved.rows[0]) {
        const current = await tx.query<{ granted: boolean }>(
          "SELECT granted FROM consents WHERE subject_id=$1 AND purpose='cloud_sync'", [subject]
        );
        if (!current.rows[0]?.granted) return false;
      }
      await tx.query(
        `INSERT INTO provider_targets(subject_id, provider, encrypted_target, updated_at)
         VALUES ($1, 'wechat', $2, now())
         ON CONFLICT(subject_id) DO UPDATE SET provider='wechat',encrypted_target=EXCLUDED.encrypted_target,updated_at=now()`,
        [subject, encryptProviderTarget(openId, config)]
      );
      return true;
    });
    if (!linked) {
      return reply.code(409).send({ error: { code: "CLOUD_SYNC_CONSENT_REVOKED", message: "云同步同意已被较新的决定撤回", requestId: request.id } });
    }
    return { accessToken: issueToken({ kind: "user", sub: subject }, config.tokenSecret, 24 * 3_600), expiresIn: 86_400, mode: "wechat" };
  });

  app.post("/v1/admin/session", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "5 minutes",
        keyGenerator: (request: FastifyRequest) => {
          const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          return `${request.ip}:${hashIdentifier(email, config.tokenSecret)}`;
        }
      }
    },
    schema: {
      tags: ["admin"],
      summary: "单管理员会话",
      body: z.object({ email: z.email().max(200), password: z.string().min(8).max(256) })
    }
  }, async (request, reply) => {
    if (!safeEqual(request.body.email.toLowerCase(), config.adminEmail.toLowerCase()) || !safeEqual(request.body.password, config.adminPassword)) {
      return unauthorized(reply, request, "ADMIN_LOGIN_FAILED", "账号或密码错误");
    }
    return { accessToken: issueToken({ kind: "admin", sub: config.adminEmail }, config.tokenSecret, 3_600), expiresIn: 3_600 };
  });

  app.put("/v1/consents", {
    schema: { tags: ["sync"], security: bearerSecurity, summary: "分别授予或撤回云同步、微信提醒同意", body: ConsentReceiptSchema }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal) return;
    if (isFutureClientTime(request.body.recordedAt)) {
      return reply.code(422).send({ error: { code: "CLIENT_TIME_IN_FUTURE", message: "同意时间超出允许的设备时钟偏差", requestId: request.id } });
    }
    const purpose = request.body.scope === "CLOUD_SYNC" ? "cloud_sync"
      : request.body.scope === "SUBSCRIPTION_MESSAGES" ? "reminders" : null;
    if (!purpose) {
      return reply.code(400).send({
        error: {
          code: "LOCAL_OR_UNLINKED_CONSENT",
          message: request.body.scope === "PSEUDONYMOUS_ANALYTICS"
            ? "统计同意只能随不含身份凭证的统计请求提交"
            : "敏感健康数据同意只保存在本地设备",
          requestId: request.id
        }
      });
    }
    const decision = await database.pg.transaction(async (tx) => {
      const saved = await tx.query<{ version: string; granted: boolean; decided_at: string | Date }>(
        `INSERT INTO consents(subject_id, purpose, version, granted, decided_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT(subject_id, purpose) DO UPDATE SET version=EXCLUDED.version, granted=EXCLUDED.granted,
           decided_at=EXCLUDED.decided_at, updated_at=now()
         WHERE consents.decided_at < EXCLUDED.decided_at
         RETURNING version,granted,decided_at`,
        [principal.sub, purpose, request.body.policyVersion, request.body.granted, request.body.recordedAt]
      );
      if (saved.rows[0]) {
        if (!request.body.granted && purpose === "reminders") {
          // `dispatching` is the durable at-most-once fence. Once a worker has
          // crossed it, a crash may make the provider outcome unknowable; a
          // revocation must stop retries without falsely claiming cancellation.
          // If an active sender holds the consent row lock, this transaction
          // waits for that irreversible operation to finish before returning.
          await tx.query(
            `UPDATE jobs SET
               status=CASE WHEN status='dispatching' THEN 'delivery_unknown' ELSE 'cancelled' END,
               completed_at=COALESCE(completed_at,now()),locked_at=NULL,
               last_error=CASE WHEN status='dispatching' THEN 'Consent revoked after dispatch fence' ELSE last_error END
             WHERE type='deliver_reminder' AND payload->>'subjectId'=$1
               AND status IN ('pending','processing','dispatching')`,
            [principal.sub]
          );
          await tx.query(
            `UPDATE reminder_intents r SET status=CASE WHEN EXISTS (
               SELECT 1 FROM jobs j WHERE j.type='deliver_reminder'
                 AND j.payload->>'reminderId'=r.id::text AND j.status='delivery_unknown'
             ) THEN 'delivery_unknown' ELSE 'cancelled' END
             WHERE r.subject_id=$1 AND r.status NOT IN ('sent','cancelled','delivery_unknown')`,
            [principal.sub]
          );
        }
        return { saved: true, idempotent: false, granted: request.body.granted };
      }

      const current = await tx.query<{ version: string; granted: boolean; decided_at: string | Date }>(
        "SELECT version,granted,decided_at FROM consents WHERE subject_id=$1 AND purpose=$2",
        [principal.sub, purpose]
      );
      const existing = current.rows[0];
      const sameDecision = existing
        && existing.version === request.body.policyVersion
        && existing.granted === request.body.granted
        && new Date(existing.decided_at).getTime() === new Date(request.body.recordedAt).getTime();
      if (sameDecision) return { saved: false, idempotent: true, granted: existing.granted };
      return null;
    });
    if (!decision) {
      return reply.code(409).send({
        error: {
          code: "STALE_CONSENT_RECEIPT",
          message: "这项同意决定早于或冲突于设备上已保存的决定，未覆盖当前状态",
          requestId: request.id
        }
      });
    }
    return { ...decision, scope: request.body.scope };
  });

  app.post("/v1/sync/push", {
    schema: {
      tags: ["sync"],
      security: bearerSecurity,
      summary: "幂等推送用户自有变更；QuitPlan 冲突必须由用户选择",
      body: SyncPushRequestSchema
    }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal || !await requireConsent(database, principal.sub, "cloud_sync", request, reply)) return;
    if (request.body.mutations.some((mutation) => isFutureClientTime(mutation.clientChangedAt) || containsFutureTimestamp(mutation.payload))) {
      return reply.code(422).send({ error: { code: "CLIENT_TIME_IN_FUTURE", message: "同步数据时间超出允许的设备时钟偏差", requestId: request.id } });
    }
    const acknowledgements: Array<Record<string, unknown>> = [];
    const conflicts: Array<Record<string, unknown>> = [];
    for (const mutation of request.body.mutations) {
      const encryptedPayload = encryptSensitiveJson(mutation.payload, config);
      const payload = encryptedPayload === null ? null : JSON.stringify(encryptedPayload);
      const fingerprint = syncFingerprint(mutation, config.identifierSecret);
      const outcome = await database.pg.transaction(async (tx) => {
        const duplicate = await tx.query<{
          revision: number;
          request_fingerprint: string | null;
        }>(
          "SELECT revision,request_fingerprint FROM sync_mutations WHERE subject_id=$1 AND mutation_id=$2",
          [principal.sub, mutation.opId]
        );
        if (duplicate.rows[0]) {
          if (!duplicate.rows[0].request_fingerprint || !safeEqual(duplicate.rows[0].request_fingerprint, fingerprint)) {
            return {
              kind: "conflict" as const,
              value: {
                objectId: mutation.objectId,
                objectType: mutation.objectType,
                localVersion: mutation.objectVersion,
                cloudVersion: duplicate.rows[0].revision,
                cloudPayload: null,
                reason: "idempotency_key_reused"
              }
            };
          }
          return {
            kind: "acknowledgement" as const,
            value: { opId: mutation.opId, status: "duplicate", revision: duplicate.rows[0].revision }
          };
        }

        const current = await tx.query<{ revision: number; payload: unknown }>(
          "SELECT revision,payload FROM subject_entities WHERE subject_id=$1 AND entity_type=$2 AND entity_id=$3",
          [principal.sub, mutation.objectType, mutation.objectId]
        );
        const row = current.rows[0];
        if (row && row.revision >= mutation.objectVersion) {
          return {
            kind: "conflict" as const,
            value: {
              objectId: mutation.objectId,
              objectType: mutation.objectType,
              localVersion: mutation.objectVersion,
              cloudVersion: row.revision,
              cloudPayload: decryptSensitiveJson(row.payload, config),
              reason: "version_requires_user_choice"
            }
          };
        }

        if (mutation.objectType === "QUIT_PLAN" && mutation.operation === "UPSERT" && mutation.payload?.status === "ACTIVE") {
          const candidates = await tx.query<{ entity_id: string; revision: number; payload: unknown }>(
            "SELECT entity_id,revision,payload FROM subject_entities WHERE subject_id=$1 AND entity_type='QUIT_PLAN' AND entity_id<>$2 AND deleted=false",
            [principal.sub, mutation.objectId]
          );
          const another = candidates.rows.find((candidate) => {
            const candidatePayload = decryptSensitiveJson(candidate.payload, config);
            return candidatePayload !== null && typeof candidatePayload === "object"
              && (candidatePayload as Record<string, unknown>).status === "ACTIVE";
          });
          if (another) {
            return {
              kind: "conflict" as const,
              value: {
                objectId: mutation.objectId,
                objectType: mutation.objectType,
                localVersion: mutation.objectVersion,
                cloudVersion: another.revision,
                cloudPayload: null,
                reason: "multiple_active_quit_plans_require_user_choice",
                otherObjectId: another.entity_id
              }
            };
          }
        }

        const entity = await tx.query<{ revision: number }>(
          `INSERT INTO subject_entities(subject_id, entity_type, entity_id, revision, payload, deleted, client_updated_at, server_updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,now())
           ON CONFLICT(subject_id, entity_type, entity_id) DO UPDATE SET revision=EXCLUDED.revision,
             payload=EXCLUDED.payload, deleted=EXCLUDED.deleted, client_updated_at=EXCLUDED.client_updated_at, server_updated_at=now()
           WHERE subject_entities.revision < EXCLUDED.revision
           RETURNING revision`,
          [principal.sub, mutation.objectType, mutation.objectId, mutation.objectVersion, payload, mutation.operation === "DELETE", mutation.clientChangedAt]
        );
        if (!entity.rows[0]) {
          const latest = await tx.query<{ revision: number; payload: unknown }>(
            "SELECT revision,payload FROM subject_entities WHERE subject_id=$1 AND entity_type=$2 AND entity_id=$3",
            [principal.sub, mutation.objectType, mutation.objectId]
          );
          const cloud = latest.rows[0];
          return {
            kind: "conflict" as const,
            value: {
              objectId: mutation.objectId,
              objectType: mutation.objectType,
              localVersion: mutation.objectVersion,
              cloudVersion: cloud?.revision ?? mutation.objectVersion,
              cloudPayload: cloud ? decryptSensitiveJson(cloud.payload, config) : null,
              reason: "version_requires_user_choice"
            }
          };
        }

        await tx.query(
          `INSERT INTO sync_mutations(mutation_id, subject_id, entity_type, entity_id, operation, revision, payload, client_updated_at, server_updated_at, request_fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now(),$9)`,
          [mutation.opId, principal.sub, mutation.objectType, mutation.objectId, mutation.operation, mutation.objectVersion, payload, mutation.clientChangedAt, fingerprint]
        );
        return {
          kind: "acknowledgement" as const,
          value: { opId: mutation.opId, status: "applied", revision: mutation.objectVersion }
        };
      });
      if (outcome.kind === "conflict") conflicts.push(outcome.value);
      else acknowledgements.push(outcome.value);
    }
    const cursorResult = await database.query<{ cursor: string }>("SELECT COALESCE(max(sequence),0)::text AS cursor FROM sync_mutations WHERE subject_id=$1", [principal.sub]);
    return { acceptedOpIds: acknowledgements.map((item) => item.opId), acknowledgements, conflicts, serverCursor: cursorResult.rows[0]?.cursor ?? "0" };
  });

  app.get("/v1/sync/pull", {
    schema: {
      tags: ["sync"],
      security: bearerSecurity,
      summary: "按游标拉取当前用户的变更",
      querystring: z.object({ cursor: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(200).default(100) })
    }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal || !await requireConsent(database, principal.sub, "cloud_sync", request, reply)) return;
    const result = await database.query<Record<string, unknown>>(
      `SELECT sequence, mutation_id AS "opId", entity_type AS "objectType", entity_id AS "objectId",
        operation, revision AS "objectVersion", payload, client_updated_at AS "clientChangedAt", server_updated_at AS "serverChangedAt"
       FROM sync_mutations WHERE subject_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT $3`,
      [principal.sub, request.query.cursor, request.query.limit]
    );
    const mutations = result.rows.map((row) => ({ ...row, payload: decryptSensitiveJson(row.payload, config) }));
    const cursor = result.rows.length > 0 ? String(result.rows[result.rows.length - 1]?.sequence) : String(request.query.cursor);
    return { mutations, cursor, hasMore: result.rows.length === request.query.limit };
  });

  app.post("/v1/reminders/intents", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: {
      tags: ["sync"],
      security: bearerSecurity,
      summary: "记录一次用户明确授权的微信提醒；不可用时返回本地降级",
      body: z.object({
        intent: ReminderIntentSchema.extend({ status: z.literal("PENDING") }),
        subscriptionGrant: z.object({ result: z.literal("accept"), requestId: z.string().min(8).max(256) }).optional()
      }).strict()
    }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal || !await requireConsent(database, principal.sub, "reminders", request, reply)) return;
    const intent = request.body.intent;
    const dueAt = new Date(intent.dueAt).getTime();
    const nowMs = Date.now();
    if (dueAt < nowMs - 5 * 60_000 || dueAt > nowMs + 400 * 86_400_000) {
      return reply.code(422).send({ error: { code: "INVALID_REMINDER_TIME", message: "提醒时间必须在当前时间至未来 400 天内", requestId: request.id } });
    }
    const target = await database.query<{ provider: string }>("SELECT provider FROM provider_targets WHERE subject_id=$1", [principal.sub]);
    const canDeliver = intent.channel === "WECHAT_SUBSCRIPTION" && target.rows[0]?.provider === "wechat"
      && Boolean(config.wechatTemplateId) && request.body.subscriptionGrant?.result === "accept";
    const id = intent.id;
    const mode = canDeliver ? "wechat" : "local-fallback";
    const saved = await database.pg.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO reminder_intents(id, subject_id, kind, scheduled_at, template_id, grant_receipt, idempotency_key, status, delivery_mode, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT DO NOTHING RETURNING id`,
        [id, principal.sub, intent.type, intent.dueAt, config.wechatTemplateId || null, request.body.subscriptionGrant?.requestId ?? null, intent.idempotencyKey, canDeliver ? "queued" : "local_only", mode]
      );
      if (!inserted.rows[0]) {
        const existing = await tx.query<{ id: string; kind: string; scheduled_at: string | Date; delivery_mode: string; grant_receipt: string | null }>(
          "SELECT id,kind,scheduled_at,delivery_mode,grant_receipt FROM reminder_intents WHERE subject_id=$1 AND idempotency_key=$2 LIMIT 1",
          [principal.sub, intent.idempotencyKey]
        );
        const row = existing.rows[0];
        if (row && row.id === id && row.kind === intent.type && new Date(row.scheduled_at).getTime() === dueAt
          && row.grant_receipt === (request.body.subscriptionGrant?.requestId ?? null)) {
          return { kind: "duplicate" as const, id: row.id, mode: row.delivery_mode };
        }
        return { kind: "conflict" as const };
      }
      if (canDeliver) {
        await tx.query(
          "INSERT INTO jobs(id,type,payload,status,attempts,available_at,created_at) VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,$3,now())",
          [randomUUID(), JSON.stringify({ reminderId: id, subjectId: principal.sub }), intent.dueAt]
        );
      }
      return { kind: "created" as const };
    });
    if (saved.kind === "conflict") {
      return reply.code(409).send({ error: { code: "IDEMPOTENCY_KEY_REUSED", message: "该幂等键已用于另一项提醒", requestId: request.id } });
    }
    if (saved.kind === "duplicate") return { id: saved.id, mode: saved.mode, idempotent: true };
    return { id, mode, message: canDeliver ? "已登记一次微信订阅提醒" : "微信提醒不可用，请保留应用内今日任务" };
  });

  app.post("/v1/telemetry/events", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    logLevel: "silent",
    schema: {
      tags: ["public"],
      summary: "独立假名统计通道；拒绝 Authorization，不能与 OpenID 联表",
      headers: z.object({ "x-analytics-id": z.uuid() }).passthrough(),
      body: z.object({ consent: ConsentReceiptSchema, events: z.array(TelemetryIntakeEventSchema).min(1).max(50) }).superRefine((value, context) => {
        if (value.consent.scope !== "PSEUDONYMOUS_ANALYTICS" || !value.consent.granted) {
          context.addIssue({ code: "custom", message: "必须单独同意假名化统计", path: ["consent"] });
        }
        value.events.forEach((event, index) => {
          for (const key of Object.keys(event.properties)) {
            if (!telemetryPropertyAllowlist.has(key)) context.addIssue({ code: "custom", message: `统计属性 ${key} 不在白名单`, path: ["events", index, "properties", key] });
          }
        });
      })
    }
  }, async (request, reply) => {
    if (request.headers.authorization || request.headers.cookie) {
      return reply.code(400).send({ error: { code: "IDENTITY_LINKAGE_FORBIDDEN", message: "统计请求不得携带身份凭证", requestId: request.id } });
    }
    const analyticsId = request.headers["x-analytics-id"] as string;
    if (isFutureClientTime(request.body.consent.recordedAt) || request.body.events.some((event) => isFutureClientTime(event.occurredAt))) {
      return reply.code(422).send({ error: { code: "CLIENT_TIME_IN_FUTURE", message: "统计时间超出允许的设备时钟偏差", requestId: request.id } });
    }
    for (const event of request.body.events) {
      if (event.analyticsId !== analyticsId) {
        return reply.code(400).send({ error: { code: "ANALYTICS_ID_MISMATCH", message: "事件统计 ID 与请求头不一致", requestId: request.id } });
      }
    }
    const accepted = await database.pg.transaction(async (tx) => {
      let count = 0;
      for (const event of request.body.events) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO telemetry_events(id,analytics_id,name,phase,properties,occurred_at,received_at,expires_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,now(),now()+interval '18 months') ON CONFLICT(id) DO NOTHING RETURNING id`,
          [event.eventId, analyticsId, event.name, event.phase, JSON.stringify(event.properties), event.occurredAt]
        );
        if (inserted.rows[0]) count += 1;
      }
      return count;
    });
    return reply.code(202).send({ accepted, duplicates: request.body.events.length - accepted, retention: "18 months", linkage: "pseudonymous-unlinked" });
  });

  app.get("/v1/data/export", {
    schema: { tags: ["sync"], security: bearerSecurity, summary: "导出当前用户的云端数据；统计数据因不可联表而不在导出中" }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal) return;
    const entities = await database.query<Record<string, unknown>>(
      `SELECT entity_type AS "entityType", entity_id AS "entityId", revision, payload, deleted,
        client_updated_at AS "clientUpdatedAt", server_updated_at AS "serverUpdatedAt"
       FROM subject_entities WHERE subject_id=$1 ORDER BY server_updated_at`, [principal.sub]
    );
    const consents = await database.query<Record<string, unknown>>(
      `SELECT purpose,version,granted,decided_at AS "decidedAt",updated_at AS "updatedAt" FROM consents WHERE subject_id=$1`, [principal.sub]
    );
    const reminders = await database.query<Record<string, unknown>>(
      `SELECT id,kind,scheduled_at AS "scheduledAt",status,delivery_mode AS "deliveryMode",created_at AS "createdAt"
       FROM reminder_intents WHERE subject_id=$1`, [principal.sub]
    );
    reply.header("content-disposition", `attachment; filename=smoke-free-export-${new Date().toISOString().slice(0, 10)}.json`);
    return {
      schemaVersion: "1", exportedAt: new Date().toISOString(), selfReported: true, biochemicalVerification: false,
      entities: entities.rows.map((row) => ({ ...row, payload: decryptSensitiveJson(row.payload, config) })),
      consents: consents.rows, reminders: reminders.rows
    };
  });

  app.post("/v1/data/export", {
    schema: { tags: ["sync"], security: bearerSecurity, summary: "按共享契约导出 JSON；不可关联统计无法导出", body: ExportRequestSchema }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal) return;
    if (request.body.includeTelemetry) {
      return reply.code(400).send({ error: { code: "UNLINKED_TELEMETRY", message: "统计 ID 与身份隔离，无法按用户检索或导出", requestId: request.id } });
    }
    if (request.body.format !== "JSON") {
      return reply.code(501).send({ error: { code: "FORMAT_NOT_AVAILABLE", message: "内部版仅提供 JSON 导出", requestId: request.id } });
    }
    const entities = await database.query<Record<string, unknown>>(
      `SELECT entity_type AS "objectType",entity_id AS "objectId",revision AS "objectVersion",payload,deleted,
       client_updated_at AS "clientChangedAt",server_updated_at AS "serverChangedAt" FROM subject_entities WHERE subject_id=$1`,
      [principal.sub]
    );
    return {
      schemaVersion: "1", exportedAt: new Date().toISOString(), selfReported: true, biochemicallyVerified: false,
      entities: entities.rows.map((row) => ({ ...row, payload: decryptSensitiveJson(row.payload, config) }))
    };
  });

  app.delete("/v1/data", {
    schema: {
      tags: ["sync"],
      security: bearerSecurity,
      summary: "撤回同意并排队删除全部可关联云端数据",
      body: z.object({ confirmation: z.literal("DELETE") })
    }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal) return;
    const deletion = await database.pg.transaction(async (tx) => {
      await tx.query("UPDATE consents SET granted=false,updated_at=now() WHERE subject_id=$1", [principal.sub]);
      await tx.query(
        `UPDATE reminder_intents r SET status='delivery_unknown'
         WHERE r.subject_id=$1 AND r.status NOT IN ('sent','cancelled','delivery_unknown')
           AND EXISTS (SELECT 1 FROM jobs j WHERE j.type='deliver_reminder'
             AND j.payload->>'reminderId'=r.id::text AND j.status IN ('dispatching','delivery_unknown'))`,
        [principal.sub]
      );
      await tx.query(
        `UPDATE jobs SET payload=$2::jsonb,
          status=CASE WHEN status IN ('dispatching','delivery_unknown') THEN 'delivery_unknown' ELSE 'cancelled' END,
          completed_at=COALESCE(completed_at,now()),locked_at=NULL,
          last_error=CASE WHEN status='dispatching' THEN 'Subject deletion requested after dispatch fence' ELSE last_error END
         WHERE type='deliver_reminder' AND payload->>'subjectId'=$1
           AND status IN ('pending','processing','dispatching','delivery_unknown')`,
        [principal.sub, JSON.stringify({ subjectDeleted: true })]
      );
      await tx.query("UPDATE reminder_intents SET status='cancelled' WHERE subject_id=$1 AND status NOT IN ('sent','delivery_unknown')", [principal.sub]);
      const existing = await tx.query<{ id: string; status: string }>(
        "SELECT id,status FROM jobs WHERE type='delete_subject' AND payload->>'subjectId'=$1 AND status IN ('pending','processing') ORDER BY created_at LIMIT 1",
        [principal.sub]
      );
      if (existing.rows[0]) return { jobId: existing.rows[0].id, status: existing.rows[0].status, idempotent: true };
      const jobId = randomUUID();
      const ownerProof = hashIdentifier(`delete-job-v1:${jobId}:${principal.sub}`, config.identifierSecret);
      await tx.query(
        "INSERT INTO jobs(id,type,payload,status,attempts,available_at,created_at) VALUES ($1,'delete_subject',$2::jsonb,'pending',0,now(),now())",
        [jobId, JSON.stringify({ subjectId: principal.sub, ownerProof })]
      );
      return { jobId, status: "pending", idempotent: false };
    });
    return reply.code(202).send({ ...deletion, backupExpiry: "at most 30 days in production backup policy" });
  });

  app.get("/v1/data/deletion/:jobId", {
    schema: { tags: ["sync"], security: bearerSecurity, params: z.object({ jobId: z.uuid() }) }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "user");
    if (!principal) return;
    const result = await database.query<{ status: string; payload: { subjectId?: string; ownerProof?: string }; completed_at: string | null }>(
      "SELECT status,payload,completed_at FROM jobs WHERE id=$1 AND type='delete_subject'", [request.params.jobId]
    );
    const job = result.rows[0];
    const expectedProof = hashIdentifier(`delete-job-v1:${request.params.jobId}:${principal.sub}`, config.identifierSecret);
    if (!job || !job.payload.ownerProof || !safeEqual(job.payload.ownerProof, expectedProof)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "删除任务不存在", requestId: request.id } });
    }
    return { status: job.status, completedAt: job.completed_at };
  });

  app.get("/v1/admin/overview", { schema: { tags: ["admin"], security: bearerSecurity, summary: "内容管理概览；不包含个人数据" } }, async (request, reply) => {
    if (!authorize(request, reply, config, "admin")) return;
    const releases = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM content_releases");
    return {
      contentVersion: contentVersion(), rulesVersion: ruleVersion(), contentCount: contentItems().length,
      evidenceCount: evidenceCatalog().length, claimCount: claimMatrix().length, releaseCount: releases.rows[0]?.count ?? 0,
      channel: "internal", status: "draft", banner: "循证草案，待医学审核", personalDataAccess: false
    };
  });

  app.get("/v1/admin/content", { schema: { tags: ["admin"], security: bearerSecurity, summary: "预览可编辑的内部草案 working copy" } }, async (request, reply) => {
    if (!authorize(request, reply, config, "admin")) return;
    const items = await workingCopy(database, "content", contentItems());
    return { version: contentVersion(), status: "draft", workingCopy: true, items, claims: claimMatrix() };
  });
  app.put("/v1/admin/content/working-copy", {
    schema: { tags: ["admin"], security: bearerSecurity, summary: "保存结构化内容草案；状态强制为 draft/internal", body: z.object({ items: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }) }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "admin");
    if (!principal) return;
    const validation = validateContentWorkingCopy(request.body.items);
    if (!validation.success) return reply.code(422).send(validation);
    await database.pg.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO admin_working_copies(kind,data,updated_by,updated_at) VALUES ('content',$1::jsonb,$2,now())
         ON CONFLICT(kind) DO UPDATE SET data=EXCLUDED.data,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [JSON.stringify(request.body.items), principal.sub]
      );
      await tx.query(
        "INSERT INTO audit_log(id,actor,action,target,metadata,occurred_at) VALUES ($1,$2,'working-copy.content.save','content',$3::jsonb,now())",
        [randomUUID(), principal.sub, JSON.stringify({ itemCount: request.body.items.length })]
      );
    });
    return { saved: true, itemCount: request.body.items.length, status: "draft", channel: "internal" };
  });
  app.get("/v1/admin/evidence", { schema: { tags: ["admin"], security: bearerSecurity, summary: "预览证据目录" } }, async (request, reply) => {
    if (!authorize(request, reply, config, "admin")) return;
    return { evidence: evidenceCatalog(), claims: claimMatrix() };
  });
  app.get("/v1/admin/rules", { schema: { tags: ["admin"], security: bearerSecurity, summary: "预览透明规则 JSON" } }, async (request, reply) => {
    if (!authorize(request, reply, config, "admin")) return;
    return { version: ruleVersion(), workingCopy: true, rules: await workingCopy(database, "rules", ruleDefinitions()) };
  });
  app.post("/v1/admin/rules/validate", {
    schema: { tags: ["admin"], security: bearerSecurity, body: z.object({ rules: z.array(z.unknown()).max(500) }) }
  }, async (request, reply) => {
    if (!authorize(request, reply, config, "admin")) return;
    const result = validateRuleDefinitions(request.body.rules);
    return reply.code(result.success ? 200 : 422).send(result);
  });
  app.put("/v1/admin/rules/working-copy", {
    schema: { tags: ["admin"], security: bearerSecurity, summary: "保存已通过白名单校验的规则草案", body: z.object({ rules: z.array(z.unknown()).max(500) }) }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "admin");
    if (!principal) return;
    const validation = validateRuleDefinitions(request.body.rules);
    if (!validation.success) return reply.code(422).send(validation);
    await database.pg.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO admin_working_copies(kind,data,updated_by,updated_at) VALUES ('rules',$1::jsonb,$2,now())
         ON CONFLICT(kind) DO UPDATE SET data=EXCLUDED.data,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [JSON.stringify(request.body.rules), principal.sub]
      );
      await tx.query(
        "INSERT INTO audit_log(id,actor,action,target,metadata,occurred_at) VALUES ($1,$2,'working-copy.rules.save','rules',$3::jsonb,now())",
        [randomUUID(), principal.sub, JSON.stringify({ ruleCount: request.body.rules.length })]
      );
    });
    return { saved: true, ruleCount: request.body.rules.length };
  });
  app.get("/v1/admin/releases", { schema: { tags: ["admin"], security: bearerSecurity } }, async (request, reply) => {
    if (!authorize(request, reply, config, "admin")) return;
    const result = await database.query<Record<string, unknown>>(
      `SELECT id,release_number AS "releaseNumber",channel,content_version AS "contentVersion",rules_version AS "rulesVersion",
        note,created_by AS "createdBy",created_at AS "createdAt",rolled_back_from AS "rolledBackFrom"
       FROM content_releases ORDER BY release_number DESC LIMIT 50`
    );
    return { releases: result.rows };
  });
  app.post("/v1/admin/releases", {
    schema: { tags: ["admin"], security: bearerSecurity, summary: "发布内部草案快照；不能标记为医学审核通过", body: AdminReleaseSchema }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "admin");
    if (!principal) return;
    const validation = validateRuleDefinitions(request.body.rules);
    if (!validation.success) return reply.code(422).send(validation);
    const id = randomUUID();
    const released = await database.pg.transaction(async (tx) => {
      const copy = await tx.query<{ data: unknown }>("SELECT data FROM admin_working_copies WHERE kind='content'");
      const draftContent = Array.isArray(copy.rows[0]?.data) ? copy.rows[0].data : contentItems();
      const linkIssues = validateRuleLinks(request.body.rules, draftContent);
      if (linkIssues.length > 0) return { issues: linkIssues } as const;
      const numberResult = await tx.query<{ next: number }>("SELECT COALESCE(max(release_number),0)::int+1 AS next FROM content_releases");
      const releaseNumber = numberResult.rows[0]?.next ?? 1;
      const snapshot = { contentVersion: contentVersion(), rulesVersion: ruleVersion(), content: draftContent, claims: claimMatrix(), evidence: evidenceCatalog(), rules: request.body.rules, status: "draft", medicalReviewed: false };
      await tx.query(
        `INSERT INTO content_releases(id,release_number,channel,content_version,rules_version,snapshot,note,created_by,created_at)
         VALUES ($1,$2,'internal-draft',$3,$4,$5::jsonb,$6,$7,now())`,
        [id, releaseNumber, contentVersion(), ruleVersion(), JSON.stringify(snapshot), request.body.note, principal.sub]
      );
      await tx.query(
        "INSERT INTO audit_log(id,actor,action,target,metadata,occurred_at) VALUES ($1,$2,'release.create',$3,$4::jsonb,now())",
        [randomUUID(), principal.sub, id, JSON.stringify({ releaseNumber, channel: "internal-draft" })]
      );
      return { releaseNumber } as const;
    });
    if ("issues" in released) return reply.code(422).send({ success: false, issues: released.issues });
    const releaseNumber = released.releaseNumber;
    return reply.code(201).send({ id, releaseNumber, channel: "internal-draft", status: "draft", banner: "循证草案，待医学审核" });
  });
  app.post("/v1/admin/releases/:releaseId/rollback", {
    schema: {
      tags: ["admin"],
      security: bearerSecurity,
      summary: "用历史快照创建新的回滚版本",
      params: z.object({ releaseId: z.uuid() }),
      body: z.object({ reason: z.string().trim().min(3).max(500), acknowledgeDraftBanner: z.literal(true) })
    }
  }, async (request, reply) => {
    const principal = authorize(request, reply, config, "admin");
    if (!principal) return;
    const source = await database.query<{ snapshot: unknown; content_version: string; rules_version: string; release_number: number }>(
      "SELECT snapshot,content_version,rules_version,release_number FROM content_releases WHERE id=$1", [request.params.releaseId]
    );
    const release = source.rows[0];
    if (!release) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "历史版本不存在", requestId: request.id } });
    const id = randomUUID();
    await database.pg.transaction(async (tx) => {
      const next = await tx.query<{ next: number }>("SELECT COALESCE(max(release_number),0)::int+1 AS next FROM content_releases");
      await tx.query(
        `INSERT INTO content_releases(id,release_number,channel,content_version,rules_version,snapshot,note,created_by,created_at,rolled_back_from)
         VALUES ($1,$2,'internal-draft',$3,$4,$5::jsonb,$6,$7,now(),$8)`,
        [id, next.rows[0]?.next ?? 1, release.content_version, release.rules_version, JSON.stringify(release.snapshot), `回滚至 #${release.release_number}：${request.body.reason}`, principal.sub, request.params.releaseId]
      );
      await tx.query(
        "INSERT INTO audit_log(id,actor,action,target,metadata,occurred_at) VALUES ($1,$2,'release.rollback',$3,$4::jsonb,now())",
        [randomUUID(), principal.sub, id, JSON.stringify({ sourceReleaseId: request.params.releaseId })]
      );
    });
    return reply.code(201).send({ id, channel: "internal-draft", status: "draft", rolledBackFrom: request.params.releaseId });
  });

  app.addHook("onClose", async () => database.close());
  return app;
}
