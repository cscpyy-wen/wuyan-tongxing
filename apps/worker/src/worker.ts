import { PGlite } from "@electric-sql/pglite";
import { initializePgliteSchema } from "@wuyan/persistence";
import type { WorkerConfig } from "./config.js";
import { decryptProviderTarget } from "./crypto.js";

interface Job {
  id: string;
  type: "delete_subject" | "deliver_reminder";
  payload: { subjectId?: string; ownerProof?: string; reminderId?: string };
  attempts: number;
}

interface ReminderRow {
  id: string;
  subject_id: string;
  kind: string;
  template_id: string | null;
  status: string;
  encrypted_target: string;
}

export interface WorkerLifecycleHooks {
  /** Test seam used to exercise the durable fence before the provider call. */
  beforeDispatchFence?: () => void | Promise<void>;
  /** Test seam used to inject a crash after the provider accepted a message. */
  afterProviderAccepted?: () => void | Promise<void>;
}

class DeliveryOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Reminder delivery outcome is unknown", { cause });
    this.name = "DeliveryOutcomeUnknownError";
  }
}

const genericReminderData: Record<string, { thing1: { value: string }; thing2: { value: string } }> = {
  TODAY_TASK: { thing1: { value: "今天的戒烟支持已准备好" }, thing2: { value: "打开小程序查看今日任务" } },
  FOLLOW_UP: { thing1: { value: "戒烟随访到了" }, thing2: { value: "欢迎记录近况，结果均为用户自报" } },
  GENTLE_RETURN: { thing1: { value: "无烟同行在这里" }, thing2: { value: "需要时可以回来继续，不评判、不清零" } }
};

export class Worker {
  private readonly pg: PGlite;
  private readonly initialization: Promise<void>;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: WorkerConfig,
    pg?: PGlite,
    private readonly lifecycleHooks: WorkerLifecycleHooks = {}
  ) {
    this.pg = pg ?? new PGlite(config.databaseDir);
    this.initialization = initializePgliteSchema(this.pg);
  }

  async ready(): Promise<void> {
    await this.initialization;
  }

  async close(): Promise<void> {
    try {
      await this.initialization;
    } finally {
      await this.pg.close();
    }
  }

  async runOnce(): Promise<boolean> {
    await this.ready();
    await this.pg.query("DELETE FROM telemetry_events WHERE expires_at < now()");
    // A process can die after the durable dispatch fence but before it records
    // the provider result. Never resend such a job: once the short provider
    // timeout is far behind us, preserve it as an explicit unknown outcome.
    await this.pg.transaction(async (tx) => {
      const stale = await tx.query<{ reminder_id: string }>(
        `UPDATE jobs SET status='delivery_unknown',completed_at=now(),locked_at=NULL,
           last_error=COALESCE(last_error,'Worker stopped after dispatch fence')
         WHERE type='deliver_reminder' AND status='dispatching'
           AND locked_at<now()-interval '10 minutes'
         RETURNING payload->>'reminderId' AS reminder_id`
      );
      const reminderIds = stale.rows.map((row) => row.reminder_id).filter(Boolean);
      if (reminderIds.length > 0) {
        await tx.query(
          "UPDATE reminder_intents SET status='delivery_unknown' WHERE id=ANY($1::uuid[]) AND status='queued'",
          [reminderIds]
        );
      }
    });
    const claimed = await this.pg.query<Job>(
      `UPDATE jobs SET status='processing',locked_at=now(),attempts=attempts+1
       WHERE id=(
         SELECT id FROM jobs
         WHERE (status='pending' AND available_at<=now())
            OR (status='processing' AND locked_at<now()-interval '10 minutes')
         ORDER BY available_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING id,type,payload,attempts`
    );
    const job = claimed.rows[0];
    if (!job) return false;
    try {
      if (job.type === "delete_subject") await this.deleteSubject(job);
      else if (job.type === "deliver_reminder") await this.deliverReminder(job);
      else throw new Error("Unsupported job type");
      return true;
    } catch (error) {
      if (error instanceof DeliveryOutcomeUnknownError) await this.markDeliveryUnknown(job, error);
      else await this.fail(job, error);
      return true;
    }
  }

  private async deleteSubject(job: Job): Promise<void> {
    const subjectId = job.payload.subjectId;
    if (!subjectId || !job.payload.ownerProof) throw new Error("Deletion job is missing ownership proof");
    await this.pg.transaction(async (tx) => {
      await tx.query(
        `UPDATE jobs SET payload=$2::jsonb,
          status=CASE WHEN status IN ('pending','processing','dispatching','delivery_unknown') THEN 'cancelled' ELSE status END,
          completed_at=CASE WHEN status IN ('pending','processing','dispatching','delivery_unknown') THEN COALESCE(completed_at,now()) ELSE completed_at END,
          locked_at=CASE WHEN status IN ('pending','processing','dispatching','delivery_unknown') THEN NULL ELSE locked_at END
         WHERE type='deliver_reminder' AND payload->>'subjectId'=$1`,
        [subjectId, JSON.stringify({ subjectDeleted: true })]
      );
      await tx.query("DELETE FROM sync_mutations WHERE subject_id=$1", [subjectId]);
      await tx.query("DELETE FROM subject_entities WHERE subject_id=$1", [subjectId]);
      await tx.query("DELETE FROM reminder_intents WHERE subject_id=$1", [subjectId]);
      await tx.query("DELETE FROM provider_targets WHERE subject_id=$1", [subjectId]);
      await tx.query("DELETE FROM consents WHERE subject_id=$1", [subjectId]);
      await tx.query(
        `UPDATE jobs SET
          payload=jsonb_build_object('ownerProof',payload->>'ownerProof'),
          status=CASE WHEN id=$2 THEN 'completed' ELSE 'cancelled' END,
          completed_at=COALESCE(completed_at,now()),locked_at=NULL,last_error=NULL
         WHERE type='delete_subject' AND payload->>'subjectId'=$1`,
        [subjectId, job.id]
      );
    });
  }

  private async deliverReminder(job: Job): Promise<void> {
    if (!job.payload.reminderId || !job.payload.subjectId) throw new Error("Reminder job is incomplete");
    // `dispatching` is a durable at-most-once fence. It is intentionally not
    // reclaimed by runOnce(): a process death after this commit has an
    // ambiguous provider outcome and must never cause a blind resend.
    const fenced = await this.pg.query<{ id: string }>(
      `UPDATE jobs SET status='dispatching',locked_at=now(),last_error=NULL
       WHERE id=$1 AND status='processing' RETURNING id`,
      [job.id]
    );
    if (!fenced.rows[0]) return;

    // Avoid turning an already ineligible reminder into a retry merely
    // because this deployment has no provider credentials. The locked query
    // below repeats this check immediately before the irreversible call.
    const eligible = await this.pg.query<{ id: string }>(
      `SELECT r.id FROM reminder_intents r
       JOIN provider_targets t ON t.subject_id=r.subject_id AND t.provider='wechat'
       JOIN consents c ON c.subject_id=r.subject_id AND c.purpose='reminders' AND c.granted=true
       WHERE r.id=$1 AND r.subject_id=$2 AND r.status='queued' AND r.delivery_mode='wechat'`,
      [job.payload.reminderId, job.payload.subjectId]
    );
    if (!eligible.rows[0]) {
      await this.pg.query(
        "UPDATE jobs SET status='cancelled',completed_at=now(),locked_at=NULL WHERE id=$1 AND status='dispatching'",
        [job.id]
      );
      return;
    }
    if (!this.config.wechatAppId || !this.config.wechatAppSecret || !this.config.wechatTemplateId) {
      throw new Error("WeChat delivery is not configured");
    }

    // Token acquisition happens before the consent row lock. A failure here
    // is known to precede the message send and can therefore be retried.
    const token = await this.getWechatAccessToken();
    await this.lifecycleHooks.beforeDispatchFence?.();

    const delivery = { outcome: "not_started" as "not_started" | "unknown" | "rejected" | "accepted" };
    try {
      await this.pg.transaction(async (tx) => {
        // Lock the consent, reminder and durable job rows through the
        // irreversible provider call. A concurrent revocation UPDATE waits;
        // once it returns, this transaction has either not sent or has fully
        // committed its terminal state.
        const result = await tx.query<ReminderRow>(
          `SELECT r.id,r.subject_id,r.kind,r.template_id,r.status,t.encrypted_target
           FROM reminder_intents r
           JOIN provider_targets t ON t.subject_id=r.subject_id
           JOIN consents c ON c.subject_id=r.subject_id AND c.purpose='reminders' AND c.granted=true
           JOIN jobs j ON j.id=$3 AND j.type='deliver_reminder' AND j.status='dispatching'
           WHERE r.id=$1 AND r.subject_id=$2 AND r.status='queued'
             AND r.delivery_mode='wechat' AND t.provider='wechat'
           FOR UPDATE OF r,c,j`,
          [job.payload.reminderId, job.payload.subjectId, job.id]
        );
        const reminder = result.rows[0];
        if (!reminder) {
          await tx.query(
            "UPDATE jobs SET status='cancelled',completed_at=now(),locked_at=NULL WHERE id=$1 AND status='dispatching'",
            [job.id]
          );
          return;
        }
        if (!reminder.template_id || reminder.template_id !== this.config.wechatTemplateId) {
          throw new Error("Reminder template is not allowlisted");
        }
        if (!Object.hasOwn(genericReminderData, reminder.kind)) throw new Error("Reminder kind is not allowlisted");
        const openId = decryptProviderTarget(reminder.encrypted_target, this.config.encryptionKey);
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(openId)) throw new Error("Stored WeChat target is invalid");

        delivery.outcome = "unknown";
        const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            touser: openId,
            template_id: reminder.template_id,
            page: "pages/today/index",
            data: genericReminderData[reminder.kind]!,
            miniprogram_state: this.config.nodeEnv === "production" ? "formal" : "developer",
            lang: "zh_CN"
          }),
          signal: AbortSignal.timeout(8_000)
        });
        const body = await response.json() as { errcode?: number; errmsg?: string };
        if (!response.ok || body.errcode !== 0) {
          delivery.outcome = "rejected";
          throw new Error(`WeChat send failed (${body.errcode ?? response.status})`);
        }
        delivery.outcome = "accepted";
        await this.lifecycleHooks.afterProviderAccepted?.();
        const reminderUpdated = await tx.query<{ id: string }>(
          "UPDATE reminder_intents SET status='sent' WHERE id=$1 AND status='queued' RETURNING id",
          [reminder.id]
        );
        const jobUpdated = await tx.query<{ id: string }>(
          `UPDATE jobs SET status='completed',completed_at=now(),locked_at=NULL,last_error=NULL
           WHERE id=$1 AND status='dispatching' RETURNING id`,
          [job.id]
        );
        if (!reminderUpdated.rows[0] || !jobUpdated.rows[0]) throw new Error("Reminder completion fence was lost");
      });
    } catch (error) {
      if (delivery.outcome === "unknown" || delivery.outcome === "accepted") {
        throw new DeliveryOutcomeUnknownError(error);
      }
      throw error;
    }
  }

  private async getWechatAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const endpoint = new URL("https://api.weixin.qq.com/cgi-bin/token");
    endpoint.searchParams.set("grant_type", "client_credential");
    endpoint.searchParams.set("appid", this.config.wechatAppId);
    endpoint.searchParams.set("secret", this.config.wechatAppSecret);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { access_token?: string; expires_in?: number; errcode?: number };
    if (!response.ok || !body.access_token) throw new Error(`WeChat token failed (${body.errcode ?? response.status})`);
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7_200) * 1_000 };
    return body.access_token;
  }

  private async fail(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 240) : "Unknown worker error";
    const terminal = job.attempts >= 5;
    const seconds = Math.min(3_600, 30 * 2 ** Math.max(0, job.attempts - 1));
    await this.pg.query(
      `UPDATE jobs SET status=$2,available_at=now()+($3::text||' seconds')::interval,
       locked_at=NULL,last_error=$4,completed_at=CASE WHEN $2='failed' THEN now() ELSE completed_at END
       WHERE id=$1 AND status IN ('processing','dispatching')`,
      [job.id, terminal ? "failed" : "pending", String(seconds), message]
    );
  }

  private async markDeliveryUnknown(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 240) : "Reminder delivery outcome is unknown";
    await this.pg.transaction(async (tx) => {
      if (job.payload.reminderId) {
        await tx.query(
          "UPDATE reminder_intents SET status='delivery_unknown' WHERE id=$1 AND status='queued'",
          [job.payload.reminderId]
        );
      }
      await tx.query(
        `UPDATE jobs SET status='delivery_unknown',completed_at=now(),locked_at=NULL,last_error=$2
         WHERE id=$1 AND status='dispatching'`,
        [job.id, message]
      );
    });
  }
}
