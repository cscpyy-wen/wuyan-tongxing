# http-cache-semantics 4.3.0 本地维护补丁

核验日期：2026-10-22。对应 [补丁](../../patches/http-cache-semantics@4.3.0.patch) 与 [独立回归](../../scripts/security-patches/http-cache-semantics.test.cjs)。这是本仓库维护的源码修补，不是上游已发布修复，也不是漏洞扫描忽略规则。

## 风险与上游状态

[GHSA-ch52-4w7c-c8xp / CVE-2026-93748](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) 的公告受影响范围截至 4.2.0，核验时仍没有列出官方修复版本。npm 注册表没有 4.2.1。4.3.0 原包仍允许请求 `max-stale` 绕过响应的重新验证限制；不能把版本超出公告范围或扫描不再报警当成修复证据。

4.3.0 的上游 [9fb520b](https://github.com/kornelski/http-cache-semantics/commit/9fb520be70eff3ff502fe965d9c3265ca2c64e26) 修复的是 CVE-2026-93750 的 Vary 通配符与继承属性问题，本补丁保留该修复。对 4.2.0 与 4.3.0 官方包源码的比较显示，`max-stale` 路径未因此改变。

上游维护者在 [issue #56](https://github.com/kornelski/http-cache-semantics/issues/56#issuecomment-5975759591) 对公告中的 Cookie 论证提出异议：[RFC 9111 §7.3](https://www.rfc-editor.org/rfc/rfc9111.html#section-7.3) 并不因存在 Set-Cookie 就禁止缓存。这里保留库原有的共享 Cookie 保守策略，同时修复有明确协议依据的 `no-cache`、共享 `proxy-revalidate`、共享 `s-maxage` 及 `must-revalidate` 约束，依据 [RFC 9111 §4.2.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.4)。该争议不能作为删除已知风险记录的理由。

## 来源、身份与许可

- 官方包：`http-cache-semantics@4.3.0`；[官方 tarball](https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.3.0.tgz)。npm `gitHead` 为 `b1d4bd682fbab0252985de45219f4e7497c0067c`。
- 官方 tarball 完整性：`sha512-M5t5LlJpS1UHMjvwRQVdFHvPISGeLAxNcrWuJkeGh0KxsqCHZ1O3NXZU/8x7cD0BDcGW8kapxMKTvwlqrNkHkA==`。先验证下载字节，再对解包源码应用补丁。
- 本补丁参考并改编 [上游 PR #63](https://github.com/kornelski/http-cache-semantics/pull/63)，审查固定提交 `497f230aaefc2013daa1d9785a6c6c34d08f6c75`，保留 Adam-Aghili 与 BobVanB 的贡献归属。核验时 PR 尚未合并。
- 原包继续使用 BSD-2-Clause，保留其 `Copyright 2016-2018 Kornel Lesiński`、完整许可条件和免责声明。补丁中的上游衍生部分沿用该许可。未修改包名、版本、`package.json`、`LICENSE` 或原包 `README.md`。
- 本地额外修正包括符合 quoted-string 边界的缓存头解析、重复/畸形指令的保守处理、格式化转义，以及旧 v1 对象恢复时重新解析原始响应头。没有新增序列化字段。

交叉审核发现初版 92 项回归未覆盖合法扩展值中的逗号，例如 `no-cache, ext="x,no-cache="`。原解析器会将引号内数据当成新指令，覆盖外部限制；`ext="x,public,y"` 还会伪造共享缓存许可。旧的 92 项证据与初版补丁哈希不能用于发布。当前版本按 [RFC 9111 §5.2](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2) 与 [RFC 9110 §5.6.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.4) 处理带引号的扩展值，并用 172 项回归重新验证。

## 精确修改范围

仅修改官方包 `index.js`，没有新依赖或替换公开 API：

| 位置（4.3.0 原始源码行号） | 行为变化 |
|---|---|
| `parseCacheControl`，126–139 与新增辅助函数 | 线性扫描识别引号和反斜杠转义；引号内逗号不分割指令；指令名统一小写；限制型指令的存在不可被空值或重复值取消；重复/非法数值与畸形语法保守标记 no-store/no-cache |
| `formatCacheControl`，147–158 | 仅遍历自身属性，对非 token 值正确加引号及转义，避免已解码值重新注入指令 |
| 构造器 / `evaluateRequest` 的 Pragma 检查 | 复用引号感知解析，仅将大小写不敏感的完整 no-cache 指令视为限制；不把扩展名或引号内文字误当成指令 |
| `evaluateRequest`，398–430 | 统一检查响应复用限制；`max-stale` 接受其精确秒数边界 |
| `_requestMatches`，456–460 | HEAD 只可匹配已有 GET，不可匹配 POST |
| `maxAge`，643–645 | `proxy-revalidate` 不再把尚新鲜的响应强行判为过期；过期后的限制交给统一检查 |
| 新增 `_allowsReuse`，原始 702 后 | 非可存储响应、`no-cache`、过期强制验证及共享 Cookie 策略优先于所有 stale 扩展 |
| `_useStaleIfError` / `useStaleWhileRevalidate`，708–717 | 使用同一限制；错误回退必须有明确的正数窗口 |
| `_fromObject`，745 / 751 | 从保留的原始响应头重建指令，消除旧解析器已经伪造的 public/immutable；保留 Pragma 回退；请求指令直接逐字段规范化，不经过字符串拼接 |
| `revalidatedPolicy`，858 | 错误回退前验证 URL、方法、Host 和 Vary 是否匹配 |

## 验证与完整性

固定入口：`node --test --test-reporter=tap scripts/security-patches/http-cache-semantics.test.cjs`。默认沿当前 Taro 开发依赖链解析实际安装包；发布验证器可通过 `WUYAN_SECURITY_PATCH_PACKAGE_PATH` 指定逐一核验过字节的包目录。缺包、身份不符或版本不符均失败，不允许跳过用例。

| 验证对象 | 结果（Node 24.14.1） |
|---|---|
| 官方未修补 4.3.0，作为反例 | 测试内逆补丁还原源码，并核对官方 index.js SHA-256；9 类真实引号注入均在原版产生复用，再由修补版恢复旧对象并拒绝 |
| 官方干净 tarball 应用本补丁 | `git apply --check` 与实际应用通过；172/172 通过、0 跳过 |
| pnpm 正式安装后的实际包 | 默认实际依赖解析下 172/172 通过、0 跳过；全部 4 个文件与独立干净解包后应用本版补丁的字节相同 |

门禁最少用例数为 **172**。检查覆盖限制响应在 `max-stale`、stale-while-revalidate、stale-if-error 三条路径的拒绝；fresh must-revalidate；共享/私有及认证矩阵；普通过期复用和 public/immutable Cookie 允许路径；Vary 通配符、继承属性和认证区分；原态与 JSON 序列化；混合大小写旧对象；错误请求身份；HEAD/POST；无错误窗口及边界；合法 304 再验证和不匹配验证器。

新增覆盖引号内逗号/等号、转义引号和反斜杠、空限制值、大小写重复指令、重复/畸形数值、共享 Cookie/Authorization 的伪造 opt-in、旧原版真实产生的污染对象及连续两次 JSON 往返、Pragma 大小写及完整 token / 扩展边界、请求侧限制与显式 ignoreCargoCult 触发格式化后的值保留。原版负控源码的 SHA-256 固定为 `ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca`。正向测试始终加载被测的实际包，逆补丁源码只用于负控。使用的域名、Cookie、token 和数据均为人工构造，测试不发起网络请求。

| 项目 | SHA-256 |
|---|---|
| `patches/http-cache-semantics@4.3.0.patch` | `5c5a8bea129d78517e0a69dc421a858dd0afa5c54b7f1e71ccf58bafee8b3077` |
| `scripts/security-patches/http-cache-semantics.test.cjs` | `81f498215fa74259c1646385e7d5a50096693dd0ffa1515bfa333c5db847e635` |
| 安装包 `index.js` | `75c20f8d1ac6057addc0f5a7e875e4b1195181e071e532b381f78dd5861be49b` |
| 安装包 `LICENSE` | `ab868ad5a2ef5068560d9cd3b2180ec63c140bb4c5cae1ba779d300a0ac74fa3` |
| 安装包 `package.json` | `dbe99941ed2092d43257294405cfb389a476ef54a029488b51125e6f3a777fde` |
| 安装包 `README.md` | `be77466544e7060ad859664e779d84db4440f6dcca28da0975d0bcd97000c9fa` |

上表 4 个安装包文件是完整清单，路径均相对于包根目录，没有 `node_modules`。补丁之外的三文件与原官方包一致。任何补丁、测试、安装字节或依赖锁变化都需重新核验；未经说明的新公告不得沿用这份特定修复的结论。

## 兼容变化与限制

- fresh `must-revalidate` 现在可按 RFC 复用；过期后仍须验证。在共享缓存中，明确的 `must-revalidate`、`public` 或 `s-maxage` 可允许原本带 Authorization 的响应被匹配请求复用。没有 `Vary: Authorization` 时，库不会自动按用户分区；源站必须为用户专属内容设置适当的 private/no-store/Vary。
- 合法 304 仍能验证受限响应。原库对不匹配 304 的恢复返回约定没有改写：调用者必须检查 `matches`、保持正确缓存键，并提供原始请求身份，不能单凭 `modified=false` 把不匹配对象作为成功验证。本补丁不声称覆盖全部 HTTP 缓存缺陷或所有调用方误用。
- 限制型 no-cache/no-store/private/must-revalidate/proxy-revalidate 包括空参数在内均按存在处理；不实现 field-qualified no-cache/private 的局部放宽。重复数值指令、非法参数和畸形头会禁用缓存，而非任选最后一个值。这是有意的保守兼容变化。合法未知扩展及 quoted-string 内容仍保留。
- 旧 v1 对象的响应指令以原始 `resh` 头为准，而非信任旧解析器已污染的 `rescc`；不再支持人为使这两个内部字段相互矛盾来改变缓存许可。已解析的指令对象使用无原型映射，JSON 表示和 v1 字段不变。
- Pragma 的旧兼容处理保留，但按完整指令而非子串匹配。[RFC 7234 §5.4](https://www.rfc-editor.org/rfc/rfc7234.html#section-5.4) 明确响应 Pragma 的含义未定义；这里的响应回退是库既有保守行为，不是协议要求。请求同时具有 Cache-Control 时库仍保守尊重 Pragma no-cache，未借此修订改变其原有取舍。
- 沿用上游对小写 HTTP 头字段输入及显式 `ignoreCargoCult` 选项的既有约定；本补丁不把该不安全兼容选项变成默认值。未验证历史 Node 6–11，也未声称已运行上游完整测试套件。
- 当前依赖来自 Taro CLI 的开发链，经 got/cacheable-request 使用。got 默认不开缓存，现有 package-json 调用未开启缓存；未建立当前应用存在远程跨用户利用的证据。这一可达性边界不代替源码修补和发布门禁。
- 上游如果发布正式修复，仍应先比较实际代码并重复回归，再移除本地补丁；不能仅因版本变化或公告范围变化而删除它。
