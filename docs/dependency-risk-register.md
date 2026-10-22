# 开发依赖风险登记

最后复核：2026-10-22。当前 v34 源码公开准备与正式 APK 发布是两件事；本轮尚未通过正式 APK 安全门禁。

## 发布判定

- `pnpm audit:all` 依次执行三个独立范围：根 pnpm 生产依赖图、根 pnpm 完整依赖图和 `deploy/tencent-cloudbase/package-lock.json`。三者都使用 `--audit-level low`，任一进程无法启动、非零退出、非 JSON/缺少计数或任意严重度计数非零都会立即失败关闭。
- `pnpm audit:prod` 也已收紧到 `low`，但它不含根完整开发图；总发布门禁必须使用 `audit:all`，不得用 `audit:prod` 代替。
- 客户端同时保留静态产物体积检查及浏览器实际加载闭包检查。v34 的 gzip 入口预算为 161 KiB，记烟／无烟两种首页实际加载闭包各为 180 KiB；准确规则见 `tests/e2e/performance.spec.ts` 与 `scripts/verify-industrial.mjs`，不能只量路由选择器而忽略按需加载模块。
- Android 构建必须通过 Gradle 8.14.3 wrapper/distribution 与 wrapper JAR 固定哈希、严格依赖验证和运行时/构建脚本锁定。当前 CycloneDX 是 773 个去重组件的平面集合，没有 `dependencies` 依赖边图；773/773 同时具有哈希和声明许可证只表示这些字段存在，不能据此推断可达性或依赖路径。
- Gradle verification metadata 当前使用构件 checksum 且 `verify-signatures=false`。checksum pinning 可以阻止与已记录字节不一致的依赖被静默接受，但没有独立认证 Maven/Gradle 发布者身份，也不是供应商签名或 provenance。
- `scripts/audit-sbom-osv.mjs` 按当前 SBOM 批量查询 722 个 npm 与 51 个 Maven PURL，并把查询时间、SBOM SHA-256 和结果写入 `docs/osv-audit.json`；任一发现或网络/协议错误均失败关闭。

## 当前状态

2026-08-29 及 v33 发布时的零发现是历史点时结论，不能用作今天的安全状态。

2026-10-22 对现有 v34 锁文件重新检查，使用 Node.js 24.14.1 和 pnpm 11.19.0：

| 范围 | 结果 |
| --- | --- |
| 根生产依赖图 | 33 条审计记录：10 moderate / 20 high / 3 critical，未通过 |
| 根完整依赖图 | 86 条审计记录：1 low / 27 moderate / 36 high / 22 critical，未通过 |
| CloudBase 部署 npm 图 | 0 条，通过 |
| 完整 SBOM OSV | 773 个组件（npm 722、Maven 51）；34 条受影响组件记录，涉及 16 个版本和 28 个通告，未通过；此次 Maven 查询 0 发现 |
| 许可证集合与 PURL 一致性 | 通过，不等于安全审计通过 |

不同审计工具的计数和传播口径不同，不能相加或等同于 Android 手机中可利用漏洞数量。官方 Android 包没有 INTERNET 权限，但这不能证明构建链、实验服务端依赖或最终 APK 都不受影响；本轮没有完成最终 APK 的完整可达性证明。

具体 OSV 记录及 SBOM 指纹见 [osv-audit.json](osv-audit.json)。根生产／全量／CloudBase 的原始审计留在维护者本地 `.audit-tmp/v34-publication-20261022/`，不公开含本机绝对路径的摘要。

### 修复与发布约束

- 多项通告已有上游修复，需要有针对性的升级、锁文件与供应链资料重建、兼容测试和新的安装包验证，不能把旧实测包的验证自动套给新包。
- `braces@3.0.3` 的 [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 在本次核查时仍未给出已发布补丁；npm 审计所建议的 `3.0.4` 在官方注册表查询不存在，不能仅据建议宣称修复。需要上游更新或可审计的替代／维护补丁及额外回归。
- 不忽略通告、不提升阈值、不把未知视为 0，不删除失败记录。公开源码或文档不表示正式 APK 门禁通过。
- 每次锁文件、SBOM 或发布版本变化都应重跑检查。点时零发现仍不能证明没有未知、未入库或标识未匹配的漏洞，也不能证明上游制品真实性或许可证法律合规。
