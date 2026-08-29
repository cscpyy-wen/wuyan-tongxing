import { PGlite } from "@electric-sql/pglite";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Worker, type WorkerLifecycleHooks } from "../src/worker.js";
import type { WorkerConfig } from "../src/config.js";
import { decryptProviderTarget } from "../src/crypto.js";

const config: WorkerConfig = {
  databaseDir: "memory://", nodeEnv: "test", encryptionKey: Buffer.alloc(32, 1).toString("base64"),
  wechatAppId: "", wechatAppSecret: "", wechatTemplateId: "", pollIntervalMs: 1
};

function encryptProviderTargetForTest(value: string, rawKey: string): string {
  const master = Buffer.from(rawKey, "base64");
  const key = createHmac("sha256", master).update("wuyan-aead-v1:provider-target").digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("wuyan-aead-v1:provider-target", "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

describe("durable PGlite worker", () => {
  let pg: PGlite;
  let worker: Worker;
  let lifecycleHooks: WorkerLifecycleHooks;
  beforeEach(async () => {
    pg = new PGlite("memory://");
    lifecycleHooks = {};
    worker = new Worker(config, pg, lifecycleHooks);
    await worker.ready();
  });
  afterEach(async () => { await worker.close(); });

  it("decrypts only the versioned provider-target AEAD domain", () => {
    const encrypted = encryptProviderTargetForTest("wx_openid_123456", config.encryptionKey);
    expect(decryptProviderTarget(encrypted, config.encryptionKey)).toBe("wx_openid_123456");
    expect(() => decryptProviderTarget(encrypted.split(".").slice(1).join("."), config.encryptionKey)).toThrow();
  });

  it("initializes every required table on a fresh PGlite database", async () => {
    const result = await pg.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    expect(result.rows.map((row) => row.tablename)).toEqual(expect.arrayContaining([
      "consents", "subject_entities", "sync_mutations", "provider_targets", "reminder_intents",
      "telemetry_events", "content_releases", "jobs", "audit_log", "admin_working_copies"
    ]));
  });

  it("deletes every subject-linked row and retains only an ownership proof", async () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const subject = "mock_subject_hash";
    await pg.query(
      `INSERT INTO sync_mutations(mutation_id,subject_id,entity_type,entity_id,operation,revision,payload,client_updated_at,server_updated_at)
       VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'QUIT_PLAN','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','UPSERT',1,'{}',now(),now())`,
      [subject]
    );
    await pg.query(
      `INSERT INTO subject_entities(subject_id,entity_type,entity_id,revision,payload,deleted,client_updated_at,server_updated_at)
       VALUES ($1,'QUIT_PLAN','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'{}',false,now(),now())`,
      [subject]
    );
    await pg.query(
      "INSERT INTO consents(subject_id,purpose,version,granted,decided_at,updated_at) VALUES ($1,'cloud_sync','1',true,now(),now())",
      [subject]
    );
    await pg.query(
      "INSERT INTO provider_targets(subject_id,provider,encrypted_target,updated_at) VALUES ($1,'wechat','ciphertext',now())",
      [subject]
    );
    const reminderId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const reminderJobId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await pg.query(
      `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
       VALUES ($1,$2,'TODAY_TASK',now()+interval '1 hour','template','grant','queued','wechat',now())`,
      [reminderId, subject]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,now()+interval '1 hour',NULL,NULL,now(),NULL)",
      [reminderJobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'delete_subject',$2::jsonb,'pending',0,now(),NULL,NULL,now(),NULL)",
      [jobId, JSON.stringify({ subjectId: subject, ownerProof: "proof" })]
    );
    const duplicateDeletionJobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'delete_subject',$2::jsonb,'pending',0,now()+interval '1 hour',NULL,NULL,now(),NULL)",
      [duplicateDeletionJobId, JSON.stringify({ subjectId: subject, ownerProof: "second-proof" })]
    );
    expect(await worker.runOnce()).toBe(true);
    for (const table of ["sync_mutations", "subject_entities", "consents", "provider_targets"]) {
      const result = await pg.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
      expect(result.rows[0]?.count).toBe(0);
    }
    const job = await pg.query<{ status: string; payload: { ownerProof: string; subjectId?: string } }>("SELECT status,payload FROM jobs WHERE id=$1", [jobId]);
    expect(job.rows[0]).toMatchObject({ status: "completed", payload: { ownerProof: "proof" } });
    expect(job.rows[0]?.payload.subjectId).toBeUndefined();
    const duplicateDeletion = await pg.query<{ status: string; payload: Record<string, unknown> }>(
      "SELECT status,payload FROM jobs WHERE id=$1", [duplicateDeletionJobId]
    );
    expect(duplicateDeletion.rows[0]).toMatchObject({ status: "cancelled", payload: { ownerProof: "second-proof" } });
    expect(JSON.stringify(duplicateDeletion.rows[0]?.payload)).not.toContain(subject);
    const reminderJob = await pg.query<{ status: string; payload: Record<string, unknown> }>(
      "SELECT status,payload FROM jobs WHERE id=$1", [reminderJobId]
    );
    expect(reminderJob.rows[0]).toMatchObject({ status: "cancelled", payload: { subjectDeleted: true } });
    expect(JSON.stringify(reminderJob.rows[0]?.payload)).not.toContain(subject);
    expect(JSON.stringify(reminderJob.rows[0]?.payload)).not.toContain(reminderId);
  });

  it("cancels a queued reminder when reminder consent is absent", async () => {
    const jobId = "22222222-2222-4222-8222-222222222222";
    const reminderId = "33333333-3333-4333-8333-333333333333";
    const subject = "wx_subject_hash";
    await pg.query(
      `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
       VALUES ($1,$2,'TODAY_TASK',now(),'template','grant','queued','wechat',now())`,
      [reminderId, subject]
    );
    await pg.query(
      "INSERT INTO provider_targets(subject_id,provider,encrypted_target,updated_at) VALUES ($1,'wechat','ciphertext',now())",
      [subject]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,now(),NULL,NULL,now(),NULL)",
      [jobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    expect(await worker.runOnce()).toBe(true);
    const job = await pg.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [jobId]);
    expect(job.rows[0]?.status).toBe("cancelled");
  });

  it("delivers only an allowlisted neutral WeChat template and commits both statuses", async () => {
    Object.assign(config, { wechatAppId: "wx-app", wechatAppSecret: "wx-secret", wechatTemplateId: "neutral-template" });
    const subject = "wx_delivery_subject";
    const reminderId = "45454545-4545-4545-8545-454545454545";
    const jobId = "56565656-5656-4656-8656-565656565656";
    await pg.query(
      "INSERT INTO consents(subject_id,purpose,version,granted,decided_at,updated_at) VALUES ($1,'reminders','1',true,now(),now())",
      [subject]
    );
    await pg.query(
      "INSERT INTO provider_targets(subject_id,provider,encrypted_target,updated_at) VALUES ($1,'wechat',$2,now())",
      [subject, encryptProviderTargetForTest("wx_openid_123456", config.encryptionKey)]
    );
    await pg.query(
      `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
       VALUES ($1,$2,'TODAY_TASK',now(),'neutral-template','grant','queued','wechat',now())`,
      [reminderId, subject]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,now(),NULL,NULL,now(),NULL)",
      [jobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token", expires_in: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
    try {
      expect(await worker.runOnce()).toBe(true);
      const reminder = await pg.query<{ status: string }>("SELECT status FROM reminder_intents WHERE id=$1", [reminderId]);
      const job = await pg.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [jobId]);
      expect(reminder.rows[0]?.status).toBe("sent");
      expect(job.rows[0]?.status).toBe("completed");
      const sendBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
      expect(sendBody).toMatchObject({ touser: "wx_openid_123456", template_id: "neutral-template", page: "pages/today/index" });
      expect(JSON.stringify(sendBody)).not.toContain("cigarette");
    } finally {
      fetchMock.mockRestore();
      Object.assign(config, { wechatAppId: "", wechatAppSecret: "", wechatTemplateId: "" });
    }
  });

  it("rechecks the durable consent fence and never overwrites a concurrent cancellation", async () => {
    Object.assign(config, { wechatAppId: "wx-app", wechatAppSecret: "wx-secret", wechatTemplateId: "neutral-template" });
    const subject = "wx_revoked_before_send";
    const reminderId = "67676767-6767-4767-8767-676767676767";
    const jobId = "78787878-7878-4787-8787-787878787878";
    await pg.query(
      "INSERT INTO consents(subject_id,purpose,version,granted,decided_at,updated_at) VALUES ($1,'reminders','1',true,now(),now())",
      [subject]
    );
    await pg.query(
      "INSERT INTO provider_targets(subject_id,provider,encrypted_target,updated_at) VALUES ($1,'wechat',$2,now())",
      [subject, encryptProviderTargetForTest("wx_openid_654321", config.encryptionKey)]
    );
    await pg.query(
      `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
       VALUES ($1,$2,'TODAY_TASK',now(),'neutral-template','grant-revoke','queued','wechat',now())`,
      [reminderId, subject]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,now(),NULL,NULL,now(),NULL)",
      [jobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    lifecycleHooks.beforeDispatchFence = async () => {
      await pg.transaction(async (tx) => {
        await tx.query("UPDATE consents SET granted=false,updated_at=now() WHERE subject_id=$1 AND purpose='reminders'", [subject]);
        await tx.query("UPDATE reminder_intents SET status='cancelled' WHERE id=$1 AND status='queued'", [reminderId]);
        await tx.query("UPDATE jobs SET status='cancelled',completed_at=now(),locked_at=NULL WHERE id=$1 AND status='dispatching'", [jobId]);
      });
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token", expires_in: 7200 }), { status: 200 }));
    try {
      expect(await worker.runOnce()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const reminder = await pg.query<{ status: string }>("SELECT status FROM reminder_intents WHERE id=$1", [reminderId]);
      const job = await pg.query<{ status: string }>("SELECT status FROM jobs WHERE id=$1", [jobId]);
      expect(reminder.rows[0]?.status).toBe("cancelled");
      expect(job.rows[0]?.status).toBe("cancelled");
    } finally {
      fetchMock.mockRestore();
      Object.assign(config, { wechatAppId: "", wechatAppSecret: "", wechatTemplateId: "" });
    }
  });

  it("never retries after the provider accepts but the local completion transaction fails", async () => {
    Object.assign(config, { wechatAppId: "wx-app", wechatAppSecret: "wx-secret", wechatTemplateId: "neutral-template" });
    const subject = "wx_delivery_unknown_subject";
    const reminderId = "89898989-8989-4989-8989-898989898989";
    const jobId = "90909090-9090-4090-8090-909090909090";
    await pg.query(
      "INSERT INTO consents(subject_id,purpose,version,granted,decided_at,updated_at) VALUES ($1,'reminders','1',true,now(),now())",
      [subject]
    );
    await pg.query(
      "INSERT INTO provider_targets(subject_id,provider,encrypted_target,updated_at) VALUES ($1,'wechat',$2,now())",
      [subject, encryptProviderTargetForTest("wx_openid_999999", config.encryptionKey)]
    );
    await pg.query(
      `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
       VALUES ($1,$2,'TODAY_TASK',now(),'neutral-template','grant-unknown','queued','wechat',now())`,
      [reminderId, subject]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'pending',0,now(),NULL,NULL,now(),NULL)",
      [jobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    lifecycleHooks.afterProviderAccepted = () => { throw new Error("injected commit failure after provider acceptance"); };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access-token", expires_in: 7200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));
    try {
      expect(await worker.runOnce()).toBe(true);
      const reminder = await pg.query<{ status: string }>("SELECT status FROM reminder_intents WHERE id=$1", [reminderId]);
      const job = await pg.query<{ status: string; attempts: number }>("SELECT status,attempts FROM jobs WHERE id=$1", [jobId]);
      expect(reminder.rows[0]?.status).toBe("delivery_unknown");
      expect(job.rows[0]).toMatchObject({ status: "delivery_unknown", attempts: 1 });
      expect(await worker.runOnce()).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      Object.assign(config, { wechatAppId: "", wechatAppSecret: "", wechatTemplateId: "" });
    }
  });

  it("reclaims a processing job after its lease expires", async () => {
    const jobId = "24242424-2424-4242-8242-242424242424";
    const reminderId = "34343434-3434-4343-8343-343434343434";
    const subject = "wx_stale_processing_subject";
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'processing',0,now(),now()-interval '11 minutes',NULL,now(),NULL)",
      [jobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    expect(await worker.runOnce()).toBe(true);
    const job = await pg.query<{ status: string; attempts: number; locked_at: string | null }>(
      "SELECT status,attempts,locked_at FROM jobs WHERE id=$1", [jobId]
    );
    expect(job.rows[0]).toMatchObject({ status: "cancelled", attempts: 1, locked_at: null });
  });

  it("archives a stale dispatch fence as unknown without sending again", async () => {
    const jobId = "25252525-2525-4252-8252-252525252525";
    const reminderId = "35353535-3535-4353-8353-353535353535";
    const subject = "wx_stale_dispatch_subject";
    await pg.query(
      `INSERT INTO reminder_intents(id,subject_id,kind,scheduled_at,template_id,grant_receipt,status,delivery_mode,created_at)
       VALUES ($1,$2,'TODAY_TASK',now(),'neutral-template','grant-stale','queued','wechat',now())`,
      [reminderId, subject]
    );
    await pg.query(
      "INSERT INTO jobs VALUES ($1,'deliver_reminder',$2::jsonb,'dispatching',1,now(),now()-interval '11 minutes',NULL,now(),NULL)",
      [jobId, JSON.stringify({ reminderId, subjectId: subject })]
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      expect(await worker.runOnce()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      const reminder = await pg.query<{ status: string }>("SELECT status FROM reminder_intents WHERE id=$1", [reminderId]);
      const job = await pg.query<{ status: string; attempts: number; locked_at: string | null }>(
        "SELECT status,attempts,locked_at FROM jobs WHERE id=$1", [jobId]
      );
      expect(reminder.rows[0]?.status).toBe("delivery_unknown");
      expect(job.rows[0]).toMatchObject({ status: "delivery_unknown", attempts: 1, locked_at: null });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
