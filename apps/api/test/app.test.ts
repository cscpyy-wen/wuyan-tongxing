import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, LOG_REDACTION_PATHS } from "../src/app.js";
import { Database } from "../src/db/database.js";
import { defaultRules } from "@wuyan/rules";
import { loadConfig } from "../src/config.js";
import { decryptSensitiveJson, encryptProviderTarget, encryptSensitiveJson, issueToken, verifyToken } from "../src/security.js";

const config = {
  nodeEnv: "test" as const,
  databaseDir: "memory://",
  tokenSecret: "test-token-secret-with-enough-entropy",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  adminEmail: "admin@internal.local",
  adminPassword: "correct-horse-battery-staple"
};

const now = "2026-08-23T10:00:00.000+08:00";
const userDevice = "11111111-1111-4111-8111-111111111111";
const secondDevice = "22222222-2222-4222-8222-222222222222";
const planId = "33333333-3333-4333-8333-333333333333";
const opId = "44444444-4444-4444-8444-444444444444";

const quitPlanPayload = (
  id = planId,
  strategy: "ABRUPT" | "REDUCE_THEN_QUIT" = "ABRUPT",
  status: "ACTIVE" | "COMPLETED" | "ARCHIVED" = "ACTIVE"
) => ({
  id,
  attemptNumber: 1,
  strategy,
  startDate: "2026-08-23",
  quitDate: "2026-08-30",
  timezone: "Asia/Shanghai" as const,
  baselineCigarettesPerDay: 10,
  pricePerPackCny: 25,
  cigarettesPerPack: 20,
  reductionTargets: [],
  status,
  createdAt: now,
  updatedAt: now
});

const dailyCheckInPayload = (id: string, cigarettesSmoked: number) => ({
  id,
  attemptId: planId,
  date: "2026-08-23",
  cigarettesSmoked,
  cravingIntensity: 4,
  mood: null,
  triggers: [],
  taskCompleted: false,
  recordedAt: now
});

describe("API security and data boundaries", () => {
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    database = await Database.open("memory://");
    app = await buildApp({ config, database });
  });
  afterEach(async () => { await app.close(); });

  async function userToken(deviceId = userDevice): Promise<string> {
    const response = await app.inject({ method: "POST", url: "/v1/auth/mock", payload: { deviceId } });
    expect(response.statusCode).toBe(200);
    return response.json().accessToken as string;
  }
  async function adminToken(): Promise<string> {
    const response = await app.inject({
      method: "POST", url: "/v1/admin/session",
      payload: { email: config.adminEmail, password: config.adminPassword }
    });
    expect(response.statusCode).toBe(200);
    return response.json().accessToken as string;
  }
  async function grantCloudSync(token: string): Promise<void> {
    const response = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` },
      payload: { id: "55555555-5555-4555-8555-555555555555", scope: "CLOUD_SYNC", granted: true, policyVersion: "1.0", recordedAt: now }
    });
    expect(response.statusCode).toBe(200);
  }
  async function grantReminders(token: string): Promise<void> {
    const response = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` },
      payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scope: "SUBSCRIPTION_MESSAGES", granted: true, policyVersion: "1.0", recordedAt: now }
    });
    expect(response.statusCode).toBe(200);
  }

  it("reports database-backed readiness and fails closed when the probe fails", async () => {
    const healthy = await app.inject({ method: "GET", url: "/health" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toEqual({ status: "ok", database: "pglite" });

    vi.spyOn(database, "assertReady").mockRejectedValueOnce(new Error("database unavailable"));
    const unavailable = await app.inject({ method: "GET", url: "/health" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: "unavailable", database: "pglite" });
  });

  it("does not report ready when a required table is missing", async () => {
    await database.query("DROP TABLE jobs");
    const unavailable = await app.inject({ method: "GET", url: "/health" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ status: "unavailable", database: "pglite" });
  });

  it("does not report ready when a uniqueness safeguard is missing", async () => {
    await database.query("DROP INDEX reminders_owner_receipt_idx");
    const unavailable = await app.inject({ method: "GET", url: "/health" });
    expect(unavailable.statusCode).toBe(503);
  });

  it("enforces role and object boundaries", async () => {
    const user = await userToken();
    const admin = await adminToken();
    expect((await app.inject({ method: "GET", url: "/v1/admin/overview", headers: { authorization: `Bearer ${user}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/sync/pull", headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(403);

    await grantCloudSync(user);
    const other = await userToken(secondDevice);
    await grantCloudSync(other);
    const pull = await app.inject({ method: "GET", url: "/v1/sync/pull", headers: { authorization: `Bearer ${other}` } });
    expect(pull.statusCode).toBe(200);
    expect(pull.json().mutations).toEqual([]);
  });

  it("requires explicit cloud-sync consent before retaining a WeChat identity", async () => {
    const missingConsent = await app.inject({ method: "POST", url: "/v1/auth/wechat", payload: { code: "wechat-code" } });
    expect(missingConsent.statusCode).toBe(400);

    const wechatDatabase = await Database.open("memory://");
    const wechatApp = await buildApp({
      database: wechatDatabase,
      config: { ...config, wechatAppId: "wx-app", wechatAppSecret: "wx-secret" }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ openid: "wx_openid_123456789" }), { status: 200 })
    );
    try {
      const response = await wechatApp.inject({
        method: "POST", url: "/v1/auth/wechat",
        payload: {
          code: "wechat-code",
          cloudSyncConsent: {
            id: "12121212-1212-4212-8212-121212121212",
            scope: "CLOUD_SYNC",
            granted: true,
            policyVersion: "1.0",
            recordedAt: now
          }
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      const targets = await wechatDatabase.query<{ encrypted_target: string }>("SELECT encrypted_target FROM provider_targets");
      expect(targets.rows[0]?.encrypted_target.startsWith("v1.")).toBe(true);
      expect(targets.rows[0]?.encrypted_target).not.toContain("wx_openid_123456789");
      const consents = await wechatDatabase.query<{ granted: boolean }>("SELECT granted FROM consents WHERE purpose='cloud_sync'");
      expect(consents.rows[0]?.granted).toBe(true);

      const push = await wechatApp.inject({
        method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${String(response.json().accessToken)}` },
        payload: { deviceId: userDevice, mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(), clientChangedAt: now }] }
      });
      expect(push.statusCode).toBe(200);
    } finally {
      fetchMock.mockRestore();
      await wechatApp.close();
    }
  });

  it("gates sync by consent, deduplicates operations and encrypts health payloads", async () => {
    const token = await userToken();
    const request = {
      deviceId: userDevice,
      mutations: [{
        opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1,
        payload: quitPlanPayload(), clientChangedAt: now
      }]
    };
    expect((await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: request })).statusCode).toBe(403);
    await grantCloudSync(token);
    const first = await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: request });
    expect(first.statusCode).toBe(200);
    expect(first.json().acceptedOpIds).toContain(opId);

    const stored = await database.query<{ payload: { alg: string; ciphertext: string } }>("SELECT payload FROM subject_entities WHERE entity_id=$1", [planId]);
    expect(stored.rows[0]?.payload.alg).toBe("A256GCM");
    expect(JSON.stringify(stored.rows[0]?.payload)).not.toContain("ABRUPT");

    const duplicate = await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: request });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().acknowledgements[0].status).toBe("duplicate");
    const pull = await app.inject({ method: "GET", url: "/v1/sync/pull", headers: { authorization: `Bearer ${token}` } });
    expect(pull.json().mutations[0].payload.strategy).toBe("ABRUPT");
  });

  it("keeps consent decisions monotonic and treats an exact replay as idempotent", async () => {
    const token = await userToken();
    await grantCloudSync(token);
    const revokedAt = "2026-08-23T10:01:00.000+08:00";
    const revoke = {
      id: "56565656-5656-4656-8656-565656565656",
      scope: "CLOUD_SYNC",
      granted: false,
      policyVersion: "1.0",
      recordedAt: revokedAt
    };
    const revoked = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` }, payload: revoke
    });
    expect(revoked.statusCode).toBe(200);

    const staleGrant = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` },
      payload: { id: "57575757-5757-4757-8757-575757575757", scope: "CLOUD_SYNC", granted: true, policyVersion: "1.0", recordedAt: now }
    });
    expect(staleGrant.statusCode).toBe(409);
    expect(staleGrant.json().error.code).toBe("STALE_CONSENT_RECEIPT");

    const replay = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` }, payload: revoke
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ idempotent: true, granted: false });
    const stored = await database.query<{ granted: boolean; decided_at: string | Date }>(
      "SELECT granted,decided_at FROM consents WHERE purpose='cloud_sync'"
    );
    expect(stored.rows[0]?.granted).toBe(false);
    expect(new Date(stored.rows[0]!.decided_at).toISOString()).toBe(new Date(revokedAt).toISOString());

    const maliciousFuture = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` },
      payload: { ...revoke, id: "58585858-5858-4858-8858-585858585858", granted: true, recordedAt: "2099-01-01T00:00:00.000+08:00" }
    });
    expect(maliciousFuture.statusCode).toBe(422);
    const unchanged = await database.query<{ granted: boolean }>("SELECT granted FROM consents WHERE purpose='cloud_sync'");
    expect(unchanged.rows[0]?.granted).toBe(false);
  });

  it("revokes pending and processing reminders without retrying a crossed dispatch fence", async () => {
    const token = await userToken();
    await grantReminders(token);
    const owner = await database.query<{ subject_id: string }>(
      "SELECT subject_id FROM consents WHERE purpose='reminders'"
    );
    const subject = owner.rows[0]!.subject_id;
    const reminders = [
      { id: "11111111-aaaa-4111-8111-111111111111", job: "21111111-aaaa-4111-8111-111111111111", status: "pending", receipt: "pending-receipt" },
      { id: "12222222-bbbb-4222-8222-222222222222", job: "22222222-bbbb-4222-8222-222222222222", status: "processing", receipt: "processing-receipt" },
      { id: "13333333-cccc-4333-8333-333333333333", job: "23333333-cccc-4333-8333-333333333333", status: "dispatching", receipt: "dispatching-receipt" },
    ];
    for (const item of reminders) {
      await database.query(
        `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
         VALUES ($1,$2,'TODAY_TASK',now(),'template',$3,'queued','wechat',now())`,
        [item.id, subject, item.receipt]
      );
      await database.query(
        `INSERT INTO jobs(id,type,payload,status,attempts,available_at,locked_at,created_at)
         VALUES ($1,'deliver_reminder',$2::jsonb,$3,1,now(),CASE WHEN $3='pending' THEN NULL ELSE now() END,now())`,
        [item.job, JSON.stringify({ reminderId: item.id, subjectId: subject }), item.status]
      );
    }

    const revoked = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` },
      payload: {
        id: "14444444-dddd-4444-8444-444444444444", scope: "SUBSCRIPTION_MESSAGES", granted: false,
        policyVersion: "1.0", recordedAt: "2026-08-23T10:01:00.000+08:00"
      }
    });
    expect(revoked.statusCode).toBe(200);

    const jobs = await database.query<{ id: string; status: string }>(
      "SELECT id,status FROM jobs WHERE type='deliver_reminder' ORDER BY id"
    );
    expect(Object.fromEntries(jobs.rows.map((row) => [row.id, row.status]))).toMatchObject({
      [reminders[0]!.job]: "cancelled",
      [reminders[1]!.job]: "cancelled",
      [reminders[2]!.job]: "delivery_unknown",
    });
    const intents = await database.query<{ id: string; status: string }>(
      "SELECT id,status FROM reminder_intents ORDER BY id"
    );
    expect(Object.fromEntries(intents.rows.map((row) => [row.id, row.status]))).toMatchObject({
      [reminders[0]!.id]: "cancelled",
      [reminders[1]!.id]: "cancelled",
      [reminders[2]!.id]: "delivery_unknown",
    });
  });

  it("scopes idempotency keys by user and commits each entity with its mutation", async () => {
    const firstToken = await userToken();
    const secondToken = await userToken(secondDevice);
    await grantCloudSync(firstToken);
    await grantCloudSync(secondToken);
    const secondObjectId = "45454545-4545-4545-8545-454545454545";
    const makeRequest = (deviceId: string, objectId: string, cigarettesSmoked: number) => ({
      deviceId,
      mutations: [{
        opId,
        objectId,
        objectType: "DAILY_CHECKIN",
        operation: "UPSERT",
        objectVersion: 1,
        payload: dailyCheckInPayload(objectId, cigarettesSmoked),
        clientChangedAt: now
      }]
    });
    const first = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${firstToken}` },
      payload: makeRequest(userDevice, planId, 3)
    });
    const second = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${secondToken}` },
      payload: makeRequest(secondDevice, secondObjectId, 7)
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().acknowledgements[0].status).toBe("applied");
    expect(second.json().acknowledgements[0].status).toBe("applied");
    const mutations = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sync_mutations WHERE mutation_id=$1", [opId]
    );
    const entities = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM subject_entities WHERE entity_id IN ($1,$2)", [planId, secondObjectId]
    );
    expect(mutations.rows[0]?.count).toBe(2);
    expect(entities.rows[0]?.count).toBe(2);
  });

  it("returns a decrypted conflict instead of silently overwriting", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const base = { deviceId: userDevice, mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(), clientChangedAt: now }] };
    expect((await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: base })).statusCode).toBe(200);
    const conflict = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: { ...base, mutations: [{ ...base.mutations[0], opId: "66666666-6666-4666-8666-666666666666" }] }
    });
    expect(conflict.statusCode).toBe(200);
    expect(conflict.json().conflicts[0]).toMatchObject({ objectId: planId, cloudVersion: 1, cloudPayload: { strategy: "ABRUPT" } });
  });

  it("rejects reuse of an operation id with different semantics", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const first = {
      deviceId: userDevice,
      mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(), clientChangedAt: now }]
    };
    expect((await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: first })).statusCode).toBe(200);
    const reused = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: { ...first, mutations: [{ ...first.mutations[0], objectId: "45454545-4545-4545-8545-454545454545", payload: quitPlanPayload("45454545-4545-4545-8545-454545454545") }] }
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json().conflicts[0]).toMatchObject({ reason: "idempotency_key_reused" });
    const stored = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM sync_mutations");
    expect(stored.rows[0]?.count).toBe(1);
  });

  it("requires an explicit user choice when a second active quit plan is pushed", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const firstPlan = {
      deviceId: userDevice,
      mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(), clientChangedAt: now }]
    };
    expect((await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: firstPlan })).statusCode).toBe(200);
    const secondPlanId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const second = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: {
        deviceId: userDevice,
        mutations: [{ opId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", objectId: secondPlanId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(secondPlanId, "REDUCE_THEN_QUIT"), clientChangedAt: now }]
      }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().conflicts[0]).toMatchObject({
      objectId: secondPlanId,
      reason: "multiple_active_quit_plans_require_user_choice",
      otherObjectId: planId
    });
    const stored = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM subject_entities WHERE entity_type='QUIT_PLAN' AND deleted=false");
    expect(stored.rows[0]?.count).toBe(1);
  });

  it("preserves archived attempts without blocking a new active quit plan", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const first = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: { deviceId: userDevice, mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(planId, "ABRUPT", "ARCHIVED"), clientChangedAt: now }] }
    });
    expect(first.statusCode).toBe(200);
    const secondPlanId = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
    const second = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: { deviceId: userDevice, mutations: [{ opId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", objectId: secondPlanId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(secondPlanId), clientChangedAt: now }] }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().conflicts).toEqual([]);
    const stored = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM subject_entities WHERE entity_type='QUIT_PLAN' AND deleted=false");
    expect(stored.rows[0]?.count).toBe(2);
  });

  it("falls back to local reminders and deduplicates an idempotency-key replay", async () => {
    const token = await userToken(); await grantReminders(token);
    const reminderId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const dueAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const payload = {
      intent: {
        id: reminderId,
        type: "TODAY_TASK",
        dueAt,
        channel: "WECHAT_SUBSCRIPTION",
        status: "PENDING",
        neutralTemplateKey: "today-task-neutral",
        idempotencyKey: "reminder-idempotency-20260824",
        createdAt: now
      },
      subscriptionGrant: { result: "accept", requestId: "wechat-request-20260824" }
    };
    const first = await app.inject({ method: "POST", url: "/v1/reminders/intents", headers: { authorization: `Bearer ${token}` }, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: reminderId, mode: "local-fallback" });
    const replay = await app.inject({ method: "POST", url: "/v1/reminders/intents", headers: { authorization: `Bearer ${token}` }, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: reminderId, mode: "local-fallback", idempotent: true });
    const reminders = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM reminder_intents");
    const jobs = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM jobs WHERE type='deliver_reminder'");
    expect(reminders.rows[0]?.count).toBe(1);
    expect(jobs.rows[0]?.count).toBe(0);

    const reused = await app.inject({
      method: "POST", url: "/v1/reminders/intents", headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, intent: { ...payload.intent, id: "dededede-dede-4ded-8ded-dededededede" } }
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("keeps telemetry pseudonymous and rejects identity linkage", async () => {
    const token = await userToken();
    const analyticsId = "77777777-7777-4777-8777-777777777777";
    const payload = {
      consent: { id: "88888888-8888-4888-8888-888888888888", scope: "PSEUDONYMOUS_ANALYTICS", granted: true, policyVersion: "1.0", recordedAt: now },
      events: [{ eventId: "99999999-9999-4999-8999-999999999999", analyticsId, name: "APP_OPENED", occurredAt: now, phase: null, properties: { page: "today", version: "0.1.0" } }]
    };
    const linked = await app.inject({ method: "POST", url: "/v1/telemetry/events", headers: { authorization: `Bearer ${token}`, "x-analytics-id": analyticsId }, payload });
    expect(linked.statusCode).toBe(400);
    const cookieLinked = await app.inject({ method: "POST", url: "/v1/telemetry/events", headers: { cookie: "session=forbidden", "x-analytics-id": analyticsId }, payload });
    expect(cookieLinked.statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: "/v1/telemetry/events", headers: { "x-analytics-id": analyticsId }, payload });
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    const replay = await app.inject({ method: "POST", url: "/v1/telemetry/events", headers: { "x-analytics-id": analyticsId }, payload });
    expect(replay.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    const leaked = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM telemetry_events WHERE properties::text LIKE '%openid%'");
    expect(leaked.rows[0]?.count).toBe(0);
  });

  it("revokes consent immediately and queues an owned deletion job", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const owner = await database.query<{ subject_id: string }>("SELECT subject_id FROM consents WHERE purpose='cloud_sync'");
    const reminderJobId = "abababab-abab-4bab-8bab-abababababab";
    await database.query(
      "INSERT INTO jobs(id,type,payload,status,attempts,available_at,created_at) VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,now()+interval '1 hour',now())",
      [reminderJobId, JSON.stringify({ subjectId: owner.rows[0]!.subject_id, reminderId: "acacacac-acac-4cac-8cac-acacacacacac" })]
    );
    const deletion = await app.inject({ method: "DELETE", url: "/v1/data", headers: { authorization: `Bearer ${token}` }, payload: { confirmation: "DELETE" } });
    expect(deletion.statusCode).toBe(202);
    const jobId = deletion.json().jobId as string;
    const replayDeletion = await app.inject({ method: "DELETE", url: "/v1/data", headers: { authorization: `Bearer ${token}` }, payload: { confirmation: "DELETE" } });
    expect(replayDeletion.statusCode).toBe(202);
    expect(replayDeletion.json()).toMatchObject({ jobId, idempotent: true });
    const status = await app.inject({ method: "GET", url: `/v1/data/deletion/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(status.statusCode).toBe(200);
    expect(status.json().status).toBe("pending");
    expect(await app.inject({ method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` }, payload: { deviceId: userDevice, mutations: [] } })).toHaveProperty("statusCode", 403);
    const reminderJob = await database.query<{ status: string; payload: Record<string, unknown> }>(
      "SELECT status,payload FROM jobs WHERE id=$1", [reminderJobId]
    );
    expect(reminderJob.rows[0]).toMatchObject({ status: "cancelled", payload: { subjectDeleted: true } });
    expect(JSON.stringify(reminderJob.rows[0]?.payload)).not.toContain(owner.rows[0]!.subject_id);
  });

  it("exports decrypted cloud data, refuses telemetry linkage and hides deletion jobs from other users", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const push = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: {
        deviceId: userDevice,
        mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: quitPlanPayload(), clientChangedAt: now }]
      }
    });
    expect(push.statusCode).toBe(200);
    const exported = await app.inject({
      method: "POST", url: "/v1/data/export", headers: { authorization: `Bearer ${token}` },
      payload: { format: "JSON", includeTelemetry: false }
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().entities[0]).toMatchObject({ objectId: planId, payload: { strategy: "ABRUPT", status: "ACTIVE" } });
    expect(JSON.stringify(exported.json())).not.toContain("A256GCM");

    const revoked = await app.inject({
      method: "PUT", url: "/v1/consents", headers: { authorization: `Bearer ${token}` },
      payload: {
        id: "56565656-5656-4656-8656-565656565656", scope: "CLOUD_SYNC", granted: false,
        policyVersion: "1.0", recordedAt: "2026-08-23T10:01:00.000+08:00"
      }
    });
    expect(revoked.statusCode).toBe(200);
    const exportAfterRevoke = await app.inject({
      method: "GET", url: "/v1/data/export", headers: { authorization: `Bearer ${token}` }
    });
    expect(exportAfterRevoke.statusCode).toBe(200);
    expect(exportAfterRevoke.json().entities[0].payload.strategy).toBe("ABRUPT");

    const telemetryExport = await app.inject({
      method: "POST", url: "/v1/data/export", headers: { authorization: `Bearer ${token}` },
      payload: { format: "JSON", includeTelemetry: true }
    });
    expect(telemetryExport.statusCode).toBe(400);
    expect(telemetryExport.json().error.code).toBe("UNLINKED_TELEMETRY");

    const deletion = await app.inject({ method: "DELETE", url: "/v1/data", headers: { authorization: `Bearer ${token}` }, payload: { confirmation: "DELETE" } });
    const other = await userToken(secondDevice);
    const hidden = await app.inject({ method: "GET", url: `/v1/data/deletion/${String(deletion.json().jobId)}`, headers: { authorization: `Bearer ${other}` } });
    expect(hidden.statusCode).toBe(404);
  });

  it("only publishes auditable internal drafts and supports working-copy edits", async () => {
    const token = await adminToken();
    const contentResponse = await app.inject({ method: "GET", url: "/v1/admin/content", headers: { authorization: `Bearer ${token}` } });
    const items = contentResponse.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const invalid = items.map((item, index) => index === 0 ? { ...item, status: "PUBLISHED" } : item);
    expect((await app.inject({ method: "PUT", url: "/v1/admin/content/working-copy", headers: { authorization: `Bearer ${token}` }, payload: { items: invalid } })).statusCode).toBe(422);
    const edited = items.map((item, index) => index === 0 ? { ...item, title: `${String(item.title)}（内部修订）` } : item);
    expect((await app.inject({ method: "PUT", url: "/v1/admin/content/working-copy", headers: { authorization: `Bearer ${token}` }, payload: { items: edited } })).statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST", url: "/v1/admin/releases", headers: { authorization: `Bearer ${token}` },
      payload: { note: "不能绕过草案标识", rules: defaultRules, evidenceReviewed: true, acknowledgeDraftBanner: false }
    });
    expect(rejected.statusCode).toBe(400);
    const release = await app.inject({
      method: "POST", url: "/v1/admin/releases", headers: { authorization: `Bearer ${token}` },
      payload: { note: "首个内部循证草案", rules: defaultRules, evidenceReviewed: true, acknowledgeDraftBanner: true }
    });
    expect(release.statusCode).toBe(201);
    expect(release.json()).toMatchObject({ channel: "internal-draft", status: "draft", banner: "循证草案，待医学审核" });
  });

  it("rolls back by creating a new internal draft with the original snapshot and an audit trail", async () => {
    const token = await adminToken();
    const created = await app.inject({
      method: "POST", url: "/v1/admin/releases", headers: { authorization: `Bearer ${token}` },
      payload: { note: "可回滚的内部版本", rules: defaultRules, evidenceReviewed: true, acknowledgeDraftBanner: true }
    });
    expect(created.statusCode).toBe(201);
    const sourceId = String(created.json().id);
    const rolledBack = await app.inject({
      method: "POST", url: `/v1/admin/releases/${sourceId}/rollback`, headers: { authorization: `Bearer ${token}` },
      payload: { reason: "恢复经过验证的上一版内容", acknowledgeDraftBanner: true }
    });
    expect(rolledBack.statusCode).toBe(201);
    expect(rolledBack.json()).toMatchObject({ channel: "internal-draft", status: "draft", rolledBackFrom: sourceId });

    const rows = await database.query<{ id: string; release_number: number; snapshot: unknown; rolled_back_from: string | null; note: string }>(
      "SELECT id,release_number,snapshot,rolled_back_from,note FROM content_releases ORDER BY release_number"
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[1]).toMatchObject({ id: rolledBack.json().id, release_number: 2, rolled_back_from: sourceId });
    expect(rows.rows[1]?.snapshot).toEqual(rows.rows[0]?.snapshot);
    expect(rows.rows[1]?.note).toContain("回滚至 #1");
    const audit = await database.query<{ action: string; target: string; metadata: { sourceReleaseId: string } }>(
      "SELECT action,target,metadata FROM audit_log WHERE action='release.rollback'"
    );
    expect(audit.rows[0]).toMatchObject({ action: "release.rollback", target: rolledBack.json().id, metadata: { sourceReleaseId: sourceId } });
  });

  it("rejects malformed sync input before storing any mutation", async () => {
    const token = await userToken(); await grantCloudSync(token);
    const malformed = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: {
        deviceId: userDevice,
        mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "EXECUTE", objectVersion: 0, payload: "not-an-object", clientChangedAt: "not-a-date" }]
      }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe("INVALID_REQUEST");
    const stored = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM sync_mutations");
    expect(stored.rows[0]?.count).toBe(0);

    const arbitrary = await app.inject({
      method: "POST", url: "/v1/sync/push", headers: { authorization: `Bearer ${token}` },
      payload: { deviceId: userDevice, mutations: [{ opId, objectId: planId, objectType: "QUIT_PLAN", operation: "UPSERT", objectVersion: 1, payload: { ...quitPlanPayload(), privateDiary: "不应上传" }, clientChangedAt: now }] }
    });
    expect(arbitrary.statusCode).toBe(400);
  });

  it("documents bearer authentication for protected OpenAPI operations", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(document.paths["/v1/sync/push"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/v1/bootstrap"].get.security).toBeUndefined();
  });

  it("rate limits repeated mock authentication attempts", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/v1/auth/mock", payload: { deviceId: userDevice } });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "POST", url: "/v1/auth/mock", payload: { deviceId: userDevice } });
    expect(limited.statusCode).toBe(429);
  });

  it("rate limits administrator logins by the socket IP even when forwarded headers change", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST", url: "/v1/admin/session", headers: { "x-forwarded-for": `198.51.100.${attempt + 1}` },
        payload: { email: config.adminEmail, password: "incorrect-password" }
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "POST", url: "/v1/admin/session", headers: { "x-forwarded-for": "203.0.113.99" },
      payload: { email: config.adminEmail, password: "incorrect-password" }
    });
    expect(limited.statusCode).toBe(429);
  });
});

describe("production safeguards", () => {
  it("redacts credentials and health-bearing fields from application logs", () => {
    expect(LOG_REDACTION_PATHS).toEqual(expect.arrayContaining([
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers[\"x-analytics-id\"]",
      "req.body.deviceId",
      "req.body.consent",
      "req.body.cloudSyncConsent",
      "req.body.subscriptionGrant",
      "req.body.mutations",
      "req.body.code",
      "req.body.password",
      "req.body.grantReceipt",
      "req.body.events[*].properties",
      "res.headers.set-cookie"
    ]));
  });

  it("fails closed on placeholder production secrets", () => {
    expect(() => loadConfig({ nodeEnv: "production" })).toThrow();
  });

  it("fails closed on an unknown environment and distrusts proxies by default", () => {
    expect(() => loadConfig({ ...config, nodeEnv: "staging" as never })).toThrow("NODE_ENV");
    expect(loadConfig(config).trustProxy).toBe(false);
  });

  it("detects tampering of AES-256-GCM health payloads", () => {
    const loaded = loadConfig(config);
    const envelope = encryptSensitiveJson({ cigarettesPerDay: 10 }, loaded);
    expect(decryptSensitiveJson(envelope, loaded)).toEqual({ cigarettesPerDay: 10 });
    if (!envelope) throw new Error("envelope missing");
    const parts = envelope.ciphertext.split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 0x01;
    parts[3] = ciphertext.toString("base64url");
    const tampered = { ...envelope, ciphertext: parts.join(".") };
    expect(() => decryptSensitiveJson(tampered, loaded)).toThrow();
    const providerCiphertext = encryptProviderTarget("openid-for-aead-domain-test", loaded);
    expect(() => decryptSensitiveJson({ alg: "A256GCM", ciphertext: providerCiphertext }, loaded)).toThrow();
  });

  it("rejects non-canonical base64url aliases before AEAD processing", () => {
    const loaded = loadConfig(config);
    let aliasedEnvelope: ReturnType<typeof encryptSensitiveJson> | null = null;
    let aliasedCiphertext = "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let padding = 0; padding < 3 && !aliasedCiphertext; padding += 1) {
      const envelope = encryptSensitiveJson({ padding: "x".repeat(padding) }, loaded);
      if (!envelope) continue;
      const parts = envelope.ciphertext.split(".");
      const canonical = parts[3]!;
      const decoded = Buffer.from(canonical, "base64url");
      for (const suffix of alphabet) {
        const candidate = `${canonical.slice(0, -1)}${suffix}`;
        if (candidate !== canonical && Buffer.from(candidate, "base64url").equals(decoded)) {
          parts[3] = candidate;
          aliasedEnvelope = envelope;
          aliasedCiphertext = parts.join(".");
          break;
        }
      }
    }
    expect(aliasedEnvelope).not.toBeNull();
    expect(aliasedCiphertext).not.toBe("");
    expect(() => decryptSensitiveJson({ ...aliasedEnvelope!, ciphertext: aliasedCiphertext }, loaded)).toThrow("Invalid encrypted ciphertext");
  });

  it("rejects non-canonical or overlong signed-token encodings", () => {
    const token = issueToken({ kind: "user", sub: "subject" }, config.tokenSecret, 60);
    expect(verifyToken(token, config.tokenSecret)).toMatchObject({ kind: "user", sub: "subject" });
    expect(verifyToken(`${token}.ignored`, config.tokenSecret)).toBeNull();
    const overlong = issueToken({ kind: "user", sub: "subject" }, config.tokenSecret, 26 * 3_600);
    expect(verifyToken(overlong, config.tokenSecret)).toBeNull();
  });

  it("refuses a production start until the PostgreSQL adapter exists", () => {
    expect(() => loadConfig({
      nodeEnv: "production",
      databaseDir: "C:/production/data",
      tokenSecret: "production-token-secret-at-least-32-characters",
      identifierSecret: "production-identifier-secret-at-least-32-characters",
      encryptionKey: Buffer.alloc(32, 9).toString("base64"),
      adminEmail: "security@example.com",
      adminPassword: "production-admin-password-strong",
      adminOrigin: "https://admin.example.com",
      clientOrigin: "https://app.example.com"
    })).toThrow("PostgreSQL production adapter");
  });
});
