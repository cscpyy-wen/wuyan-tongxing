import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiClient, login, type Overview, type ReleaseRecord } from "./api";

type Tab = "overview" | "content" | "evidence" | "rules" | "releases";
type RecordLike = Record<string, unknown>;

const TOKEN_KEY = "wuyan-admin-session";
const text = (record: unknown, ...keys: string[]): string => {
  if (!record || typeof record !== "object") return "";
  for (const key of keys) {
    const value = (record as RecordLike)[key];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return "";
};

function Login({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [email, setEmail] = useState("admin@internal.local");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try { onAuthenticated(await login(email, password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setBusy(false); }
  };
  return <main className="login-shell">
    <section className="login-copy">
      <span className="eyebrow">无烟同行 · INTERNAL</span>
      <h1>让每一句健康建议<br />都可以被追溯。</h1>
      <p>管理循证内容、证据矩阵和透明规则。这个后台从设计上不具备查看用户戒烟记录的接口。</p>
      <div className="privacy-seal"><span aria-hidden="true">◉</span><div><strong>个人记录隔离</strong><small>内容管理员无法访问个人健康信息</small></div></div>
    </section>
    <form className="login-card" onSubmit={submit}>
      <div className="brand-mark" aria-hidden="true"><span>无</span></div>
      <h2>内容管理后台</h2><p>仅限授权的单管理员使用</p>
      <label>管理员邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? "正在验证…" : "进入后台"}</button>
      <small>会话仅保存在当前标签页，1 小时后过期。</small>
    </form>
  </main>;
}

function Stat({ value, label, accent }: { value: number | string; label: string; accent?: boolean }) {
  return <article className={`stat ${accent ? "accent" : ""}`}><strong>{value}</strong><span>{label}</span></article>;
}

function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

function JsonPreview({ value }: { value: unknown }) {
  return <pre className="json-preview">{JSON.stringify(value, null, 2)}</pre>;
}

function ContentEditor({ item, onChange }: { item: RecordLike; onChange: (item: RecordLike) => void }) {
  const field = (key: string) => text(item, key);
  const update = (key: string, value: unknown) => onChange({ ...item, [key]: value, status: "draft", channel: "internal" });
  const lines = (key: string) => Array.isArray(item[key])
    ? (item[key] as unknown[]).filter((value): value is string => typeof value === "string").join("\n") : "";
  return <div className="content-editor">
    <div className="field-row"><label>内容 ID<input value={field("id")} disabled /></label><label>类型<input value={field("kind")} disabled /></label></div>
    <label>标题<input value={field("title")} onChange={(event) => update("title", event.target.value)} /></label>
    <label>目标<textarea value={field("goal")} onChange={(event) => update("goal", event.target.value)} /></label>
    <label>正文<textarea className="long" value={field("body")} onChange={(event) => update("body", event.target.value)} /></label>
    <label>步骤（每行一项）<textarea value={lines("steps")} onChange={(event) => update("steps", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))} /></label>
    <label>行动建议<textarea value={field("action")} onChange={(event) => update("action", event.target.value)} /></label>
    <label>风险边界<textarea value={field("riskStatement")} onChange={(event) => update("riskStatement", event.target.value)} /></label>
    <label>证据 ID（每行一项）<textarea value={lines("evidenceIds")} onChange={(event) => update("evidenceIds", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))} /></label>
  </div>;
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [content, setContent] = useState<unknown[]>([]);
  const [evidence, setEvidence] = useState<unknown[]>([]);
  const [claims, setClaims] = useState<unknown[]>([]);
  const [rules, setRules] = useState<unknown[]>([]);
  const [releases, setReleases] = useState<ReleaseRecord[]>([]);
  const [selected, setSelected] = useState<unknown>(null);
  const [ruleText, setRuleText] = useState("[]");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const client = useMemo(() => token ? new ApiClient(token) : null, [token]);

  const signOut = useCallback(() => { sessionStorage.removeItem(TOKEN_KEY); setToken(""); }, []);
  const authenticate = (next: string) => { sessionStorage.setItem(TOKEN_KEY, next); setToken(next); };

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true); setError("");
    try {
      const [overviewData, contentData, evidenceData, rulesData, releasesData] = await Promise.all([
        client.overview(), client.content(), client.evidence(), client.rules(), client.releases()
      ]);
      setOverview(overviewData); setContent(contentData.items); setEvidence(evidenceData.evidence);
      setClaims(evidenceData.claims); setRules(rulesData.rules); setRuleText(JSON.stringify(rulesData.rules, null, 2));
      setReleases(releasesData.releases);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "读取失败";
      setError(message);
      if (/身份|凭证|过期/.test(message)) signOut();
    } finally { setLoading(false); }
  }, [client, signOut]);

  useEffect(() => { void refresh(); }, [refresh]);
  if (!token) return <Login onAuthenticated={authenticate} />;

  const filteredContent = content.filter((item) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));
  const validateRules = async () => {
    if (!client) return;
    setError(""); setNotice("");
    try {
      const parsed = JSON.parse(ruleText) as unknown;
      if (!Array.isArray(parsed)) throw new Error("规则根节点必须是数组");
      const result = await client.validateRules(parsed);
      if (!result.success) throw new Error(result.issues.join("；"));
      await client.saveRules(parsed);
      setRules(parsed); setNotice(`规则校验通过并保存 working copy，共 ${parsed.length} 条。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "规则无效"); }
  };
  const publish = async () => {
    if (!client) return;
    const note = window.prompt("请输入本次内部草案发布说明（至少 3 个字符）");
    if (!note) return;
    setError("");
    try {
      const parsed = JSON.parse(ruleText) as unknown;
      if (!Array.isArray(parsed)) throw new Error("规则根节点必须是数组");
      await client.saveContent(content);
      await client.saveRules(parsed);
      await client.createRelease(note, parsed);
      setNotice("内部草案已发布；仍保持“待医学审核”标识。");
      await refresh(); setTab("releases");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "发布失败"); }
  };
  const updateSelectedContent = (nextItem: RecordLike) => {
    const index = content.indexOf(selected);
    if (index < 0) return;
    const next = [...content];
    next[index] = nextItem;
    setContent(next); setSelected(nextItem);
  };
  const saveContent = async () => {
    if (!client) return;
    try { await client.saveContent(content); setNotice(`已保存 ${content.length} 项结构化草案。`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
  };
  const rollback = async (release: ReleaseRecord) => {
    if (!client) return;
    const reason = window.prompt(`将以 #${release.releaseNumber} 的快照创建一个新版本。请输入原因：`);
    if (!reason) return;
    try { await client.rollback(release.id, reason); setNotice("已创建新的回滚版本，历史记录未被覆盖。"); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "回滚失败"); }
  };

  const nav: Array<{ id: Tab; label: string; icon: string }> = [
    { id: "overview", label: "总览", icon: "⌂" }, { id: "content", label: "内容", icon: "▤" },
    { id: "evidence", label: "证据", icon: "◎" }, { id: "rules", label: "规则", icon: "◇" },
    { id: "releases", label: "发布记录", icon: "↺" }
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="side-brand"><div className="brand-mark small"><span>无</span></div><div><strong>无烟同行</strong><small>内容管理台</small></div></div>
      <nav aria-label="主导航">{nav.map((entry) => <button key={entry.id} className={tab === entry.id ? "active" : ""} onClick={() => { setTab(entry.id); setSelected(null); }}><span>{entry.icon}</span>{entry.label}</button>)}</nav>
      <div className="sidebar-foot"><div className="status-dot"><i />内部环境</div><button onClick={signOut}>退出登录</button></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div><span className="eyebrow">CONTENT OPERATIONS</span><h1>{nav.find((entry) => entry.id === tab)?.label}</h1></div><div className="draft-chip"><i /> 循证草案 · 待医学审核</div></header>
      {error && <div className="alert error" role="alert"><span>{error}</span><button aria-label="关闭" onClick={() => setError("")}>×</button></div>}
      {notice && <div className="alert success" role="status"><span>{notice}</span><button aria-label="关闭" onClick={() => setNotice("")}>×</button></div>}
      {loading && <div className="loading-bar" aria-label="正在加载" />}

      {tab === "overview" && <section>
        <div className="hero-card"><div><span className="eyebrow">版本健康度</span><h2>内容可追溯，边界可见。</h2><p>本环境只允许发布内部草案。医学审核完成前，客户端会持续显示明确提示。</p></div><div className="version-orbit"><span>CONTENT</span><strong>{overview?.contentVersion ?? "—"}</strong><small>RULES {overview?.rulesVersion ?? "—"}</small></div></div>
        <div className="stats-grid"><Stat value={overview?.contentCount ?? 0} label="内容条目" accent /><Stat value={overview?.evidenceCount ?? 0} label="证据来源" /><Stat value={overview?.claimCount ?? 0} label="主张映射" /><Stat value={overview?.releaseCount ?? 0} label="发布快照" /></div>
        <div className="guardrail"><div className="guard-icon">⌁</div><div><h3>数据访问护栏</h3><p>该后台 API 仅暴露内容、证据、规则与发布记录；不存在检索用户问卷、烟瘾或戒烟记录的管理员接口。</p></div><strong>{overview?.personalDataAccess === false ? "已隔离" : "检查中"}</strong></div>
      </section>}

      {tab === "content" && <section className="split-view">
        <div className="panel list-panel"><div className="panel-head"><div><h2>内容目录</h2><small>{filteredContent.length} / {content.length} 项</small></div><input aria-label="搜索内容" placeholder="搜索标题、类型或 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="item-list">{filteredContent.map((item, index) => <button key={text(item, "id") || index} className={selected === item ? "selected" : ""} onClick={() => setSelected(item)}><span className="kind">{text(item, "kind", "type", "category") || "内容"}</span><strong>{text(item, "title", "name", "id") || `条目 ${index + 1}`}</strong><small>{text(item, "summary", "description", "id")}</small></button>)}</div></div>
        <div className="panel detail-panel">{selected ? <><div className="panel-head"><div><span className="kind">结构化 working copy</span><h2>{text(selected, "title", "name", "id")}</h2></div><button className="primary" onClick={() => void saveContent()}>保存草案</button></div><ContentEditor item={selected as RecordLike} onChange={updateSelectedContent} /></> : <Empty>选择左侧内容编辑结构化草案</Empty>}</div>
      </section>}

      {tab === "evidence" && <section><div className="section-heading"><div><h2>证据与主张矩阵</h2><p>发布前确认每条健康主张都能追溯到来源和复核日期。</p></div><div className="count-pills"><span>{evidence.length} 来源</span><span>{claims.length} 主张</span></div></div>
        <div className="evidence-grid">{evidence.map((item, index) => <article key={text(item, "id", "url") || index} onClick={() => setSelected(item)}><span className="evidence-index">{String(index + 1).padStart(2, "0")}</span><div><span className="kind">{text(item, "organization", "sourceType", "type") || "循证来源"}</span><h3>{text(item, "title", "name") || "未命名证据"}</h3><p>{text(item, "citation", "summary", "url")}</p></div></article>)}</div>
        {selected !== null && <div className="drawer"><button aria-label="关闭预览" onClick={() => setSelected(null)}>×</button><JsonPreview value={selected} /></div>}
      </section>}

      {tab === "rules" && <section className="rules-layout"><div className="section-heading"><div><h2>白名单 JSON 规则</h2><p>仅允许声明式条件和内容 ID；禁止脚本、自由代码与黑箱模型。</p></div><div className="toolbar"><button onClick={() => setRuleText(JSON.stringify(rules, null, 2))}>恢复已加载版本</button><button onClick={validateRules}>校验规则</button><button className="primary" onClick={publish}>发布内部草案</button></div></div><textarea className="rule-editor" spellCheck={false} value={ruleText} onChange={(event) => setRuleText(event.target.value)} aria-label="规则 JSON 编辑器" /><div className="editor-foot"><span>RULESET · {overview?.rulesVersion}</span><span>{ruleText.split("\n").length} 行</span></div></section>}

      {tab === "releases" && <section><div className="section-heading"><div><h2>不可覆盖的版本历史</h2><p>发布和回滚都会创建新快照，保留操作链路。</p></div><button onClick={() => void refresh()}>刷新</button></div>
        <div className="release-list">{releases.length === 0 ? <Empty>尚未创建内部发布快照</Empty> : releases.map((release, index) => <article key={release.id}><div className="release-line"><i className={index === 0 ? "latest" : ""} /></div><div className="release-number">#{release.releaseNumber}</div><div className="release-main"><div><h3>{release.note}</h3><p>{new Date(release.createdAt).toLocaleString("zh-CN")} · {release.createdBy}</p></div><div className="release-tags"><span>{release.channel}</span>{release.rolledBackFrom && <span>回滚版本</span>}</div></div><button onClick={() => void rollback(release)}>以此版本回滚</button></article>)}</div>
      </section>}
    </main>
  </div>;
}
