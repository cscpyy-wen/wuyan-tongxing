# 开发依赖风险登记

最后复核：2026-10-22。依赖修复与正式 APK 发布是不同的验收范围，最终签名、精确提交 CI 和公开下载身份以对应 Release 附件为准。

## v34 修复后状态

维护者已明确批准采用公开、可审计的本地补丁。发布要求为 **low 阈值无未处置项**，不称“原始扫描零告警”。实际 npm 生产图与完整图各保留 1 条 braces 警报，CloudBase 为 0；OSV 对 773 个组件（npm 722、Maven 51）保留 1 条 braces 记录，Maven 0。原始结果与逐项处置见 [dependency-audit.json](dependency-audit.json) 和 [osv-audit.json](osv-audit.json)。重复报告不能相加成手机中可利用漏洞数量。

braces 保留 3.0.3 身份并修补深度/父链限制，实际安装包通过 807 项回归；http-cache-semantics 保留 4.3.0 身份并修补响应头解析、过期复用和旧缓存恢复，实际安装包通过 172 项回归，另有 1,765 个独立参数化场景。4.3.0 原包虽未被扫描器范围命中，仍实际复现问题，因此不能只靠版本升级认定修复。完整来源、指纹和边界见[安全补丁说明](security-patches/README.md)。

## 发布判定

- `pnpm audit:all` 实时查询根生产图、根完整图和 CloudBase 独立图，均使用 `low`，不改写工作树。`pnpm audit:all --write-report` 保存原始结果供审查和提交。未知通告、版本/公告事实变化、证据缺失、网络/解析/计数错误或未修复项均阻止发布。
- 补丁判定不是通告白名单：每次绑定上游完整性、锁快照、补丁与测试哈希、每个实际安装副本的全部文件（含别名）及复核期限，并重新执行回归。未修补版本、篡改、超时、失败、跳过、零用例或数量不足都不能通过。
- `pnpm audit:prod` 也已收紧到 `low`，但它不含根完整开发图；总发布门禁必须使用 `audit:all`，不得用 `audit:prod` 代替。
- 客户端同时保留静态产物体积检查及浏览器实际加载闭包检查。v34 的 gzip 入口预算为 161 KiB，记烟／无烟两种首页实际加载闭包各为 180 KiB；准确规则见 `tests/e2e/performance.spec.ts` 与 `scripts/verify-industrial.mjs`，不能只量路由选择器而忽略按需加载模块。
- Android 构建必须通过 Gradle 8.14.3 wrapper/distribution 与 wrapper JAR 固定哈希、严格依赖验证和运行时/构建脚本锁定。当前 CycloneDX 是 773 个去重组件的平面集合，没有 `dependencies` 依赖边图；773/773 同时具有哈希和声明许可证只表示这些字段存在，不能据此推断可达性或依赖路径。
- Gradle verification metadata 当前使用构件 checksum 且 `verify-signatures=false`。checksum pinning 可以阻止与已记录字节不一致的依赖被静默接受，但没有独立认证 Maven/Gradle 发布者身份，也不是供应商签名或 provenance。
- OSV 保留原始 `findingCount` 与 `findings`，另列补丁处置，不把 `patch_hash` 混入上游版本/PURL来避开扫描。任何未读分页或未处置发现、网络/协议错误均失败关闭。正式构建实时核对已提交报告、24 小时时效和当前 SBOM；APK 验证再次根据实际补丁重新计算处置，不信任手填的零值。

## 修复前失败历史（保留）

2026-08-29 及 v33 发布时的零发现是历史点时结论，不能用作今天的安全状态。

2026-10-22 修复前对 v34 锁文件重新检查，使用 Node.js 24.14.1 和 pnpm 11.19.0：

| 范围 | 结果 |
| --- | --- |
| 根生产依赖图 | 33 条审计记录：10 moderate / 20 high / 3 critical，未通过 |
| 根完整依赖图 | 86 条审计记录：1 low / 27 moderate / 36 high / 22 critical，未通过 |
| CloudBase 部署 npm 图 | 0 条，通过 |
| 完整 SBOM OSV | 773 个组件（npm 722、Maven 51）；34 条受影响组件记录，涉及 16 个版本和 28 个通告，未通过；此次 Maven 查询 0 发现 |
| 许可证集合与 PURL 一致性 | 通过，不等于安全审计通过 |

不同审计工具的计数和传播口径不同，不能相加或等同于 Android 手机中可利用漏洞数量。官方 Android 包没有 INTERNET 权限，但这不能证明构建链、实验服务端依赖或最终 APK 都不受影响；本轮没有完成最终 APK 的完整可达性证明。

修复前的具体记录保留在[已提交 OSV 历史报告](https://github.com/cscpyy-wen/wuyan-tongxing/blob/f63a35cce8ca67d8d7138aeee29cb7c4f47060fc/docs/osv-audit.json)。其他原始审计留在维护者本地 `.audit-tmp/v34-publication-20261022/`，不公开含本机绝对路径的摘要。第一轮缓存补丁被独立审核发现有效引号扩展边界后，已修正并扩充回归；旧补丁通过结果不作为最终放行证据。

### 修复与发布约束

- 多项通告已采用上游修复版本，见[兼容复核](dependency-compatibility-waivers.md)。每次变化仍需重建清单、回归和新安装包验证，不能把旧实测包的验证自动套给新包。
- `braces@3.0.3` 的 [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 在本次核查时仍未给出已发布补丁；npm 审计所建议的 `3.0.4` 在官方注册表查询不存在，不能仅据建议宣称修复。需要上游更新或可审计的替代／维护补丁及额外回归。
- 不忽略通告、不提升阈值、不把未知视为 0，不删除失败记录。采用维护者明确批准的逐公告补丁验证后，原始警报和实际处置分别列示。公开源码或文档不表示正式 APK 门禁通过。
- 每次锁文件、SBOM 或发布版本变化都应重跑检查。点时零发现仍不能证明没有未知、未入库或标识未匹配的漏洞，也不能证明上游制品真实性或许可证法律合规。
