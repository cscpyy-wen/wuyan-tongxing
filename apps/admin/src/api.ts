export interface Overview {
  contentVersion: string;
  rulesVersion: string;
  contentCount: number;
  evidenceCount: number;
  claimCount: number;
  releaseCount: number;
  channel: "internal";
  status: "draft";
  banner: string;
  personalDataAccess: false;
}

export interface ReleaseRecord {
  id: string;
  releaseNumber: number;
  channel: string;
  contentVersion: string;
  rulesVersion: string;
  note: string;
  createdBy: string;
  createdAt: string;
  rolledBackFrom: string | null;
}

interface ErrorPayload { error?: { message?: string } }

export class ApiClient {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ErrorPayload;
      throw new Error(body.error?.message ?? `请求失败（${response.status}）`);
    }
    return response.json() as Promise<T>;
  }

  overview() { return this.request<Overview>("/v1/admin/overview"); }
  content() { return this.request<{ version: string; status: string; items: unknown[]; claims: unknown[] }>("/v1/admin/content"); }
  evidence() { return this.request<{ evidence: unknown[]; claims: unknown[] }>("/v1/admin/evidence"); }
  rules() { return this.request<{ version: string; rules: unknown[] }>("/v1/admin/rules"); }
  releases() { return this.request<{ releases: ReleaseRecord[] }>("/v1/admin/releases"); }
  validateRules(rules: unknown[]) {
    return this.request<{ success: boolean; issues: string[] }>("/v1/admin/rules/validate", { method: "POST", body: JSON.stringify({ rules }) });
  }
  saveContent(items: unknown[]) {
    return this.request<{ saved: boolean; itemCount: number }>("/v1/admin/content/working-copy", { method: "PUT", body: JSON.stringify({ items }) });
  }
  saveRules(rules: unknown[]) {
    return this.request<{ saved: boolean; ruleCount: number }>("/v1/admin/rules/working-copy", { method: "PUT", body: JSON.stringify({ rules }) });
  }
  createRelease(note: string, rules: unknown[]) {
    return this.request<{ id: string; releaseNumber: number }>("/v1/admin/releases", {
      method: "POST",
      body: JSON.stringify({ note, rules, evidenceReviewed: true, acknowledgeDraftBanner: true })
    });
  }
  rollback(releaseId: string, reason: string) {
    return this.request<{ id: string }>(`/v1/admin/releases/${releaseId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ reason, acknowledgeDraftBanner: true })
    });
  }
}

export async function login(email: string, password: string): Promise<string> {
  const response = await fetch("/v1/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const body = await response.json() as { accessToken?: string; error?: { message?: string } };
  if (!response.ok || !body.accessToken) throw new Error(body.error?.message ?? "登录失败");
  return body.accessToken;
}
