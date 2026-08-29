# 腾讯 CloudBase 国内 H5 内测部署

此目录把已构建的 `apps/client/dist/h5` 转换为可部署到腾讯云 CloudBase 静态网站托管根路径的 H5 包。访客无需登录；腾讯云登录只用于部署者创建和管理托管环境。

## 构建与校验

在仓库根目录执行：

```powershell
pnpm build:cn-preview
npm --prefix deploy/tencent-cloudbase run package
```

输出：

- `dist/`：上传或 CLI 部署的站点根目录。`index.html` 必须位于托管根目录，不能额外包一层 `h5/`。
- `artifacts/SHA256SUMS.txt`：逐文件 SHA-256 校验清单。
- `artifacts/resolved-security-headers.json`：绑定自定义域名并配置 HTTP 路由时使用的安全响应头参考。
- `artifacts/wuyan-tongxing-cloudbase-h5-0.1.0-rc.1.zip`：控制台上传包；ZIP 根直接包含 `index.html`，并使用固定条目时间生成以保持同一产物的字节可复现。
- `artifacts/ARTIFACT-SHA256SUMS.txt`：ZIP、安全响应头参考和站点逐文件清单的持久化摘要。

构建会为入口加入精确哈希 CSP、`noindex` 与 `no-referrer`，并重新生成版本化离线缓存。当前路由、资源和 Service Worker 均使用绝对根路径 `/`，因此只能部署在独立域名根目录。

## 部署

运行 `npm ci --prefix deploy/tencent-cloudbase` 后，以下命令使用该目录 lockfile 固定的官方 `@cloudbase/cli@3.8.0`。先按实际环境设置环境 ID 与地域：

```powershell
$env:TCB_ENV_ID = '<cloudbase-env-id>'
$env:TCB_REGION = 'ap-shanghai'
npm --prefix deploy/tencent-cloudbase exec -- tcb login --flow device
npm --prefix deploy/tencent-cloudbase exec -- tcb env list --region $env:TCB_REGION --json
npm --prefix deploy/tencent-cloudbase exec -- tcb hosting deploy deploy/tencent-cloudbase/dist -e $env:TCB_ENV_ID --region $env:TCB_REGION
```

`tcb hosting deploy` 是无版本管理的逐文件上传，只允许用于当前默认域名的小范围内部测试，不能作为生产或共享候选发布。更新前暂停分发链接，上传完成后执行全量远端校验；正式候选应在 CloudBase 控制台使用“静态网站托管 → 新建部署 → 上传代码包”，保留并记录应用版本 ID，并在暴露流量前完成真实回滚演练。部署到根路径，不启用访问身份认证。

CloudBase 默认 `*.tcloudbaseapp.com` 域名仅用于内部测试，可能显示访问提示页并受风控或频率限制。面向公众的稳定入口必须换成已完成 ICP 备案的自定义域名并启用 HTTPS；之后在 HTTP 访问服务路由中逐项补齐并在线核对 `artifacts/resolved-security-headers.json`，其中 HSTS 只适用于确认全站及子域均为 HTTPS 的自有域名，不能配置给共享默认域名。`/sw.js` 与 `/index.html` 的节点和浏览器缓存均设为 0/不缓存；固定文件名的 JS、CSS 和 chunk 设为 `max-age=0, must-revalidate`。Service Worker 的升级预缓存会使用 `cache: reload` 绕过旧 HTTP 缓存。

该包只部署免登录静态 H5，不部署 API、Worker、内容后台、云同步、统计或订阅消息发送。获得腾讯地址、绑定域名或完成备案都不等于完整产品已经生产上线。

部署时记录环境 `<cloudbase-env-id>`、预览版本 `<preview-version>`、根路径 `/` 与默认域名 `<cloudbase-default-domain>`，但不要把真实环境标识或默认域名提交到公开源码。发布后可执行逐文件线上哈希校验：

```powershell
npm --prefix deploy/tencent-cloudbase run verify:live -- https://<cloudbase-default-domain>
```

该校验会下载并核对清单内全部 37 个文件的 SHA-256、MIME 与状态码，检查首页无跳转及缺失资源返回 404，并明确报告默认域名缺少的服务端安全响应头。

## 发布后门禁

1. `GET /`、`/js/app.js`、任一 `chunk/*.js`、`/sw.js` 均返回 200 且 MIME 正确；不存在的静态资源必须返回 404，不能回退 HTML 200。
2. `/#/pages/onboarding/index` 可打开并刷新；首次页面明确显示“无需登录”。
3. 拒绝所有可选同意后仍能完成首次设置、今日任务、记录、进展、SOS、导出和删除。
4. 首次联网后切断网络，SOS 与核心页面仍可打开。
5. 微信 Android/iOS 真机分别测试；再用中国移动、联通、电信网络抽测。
6. 默认域名只标记为内部测试；正式发布前完成自有域名、ICP、小程序/APP 备案与医学内容具名审核。
7. 自有域名用 `curl -I` 或同等工具逐项核对 CSP、HSTS、XFO、nosniff、权限策略、Referrer、缓存头和 `Service-Worker-Allowed`；任何缺失均停止发布。
