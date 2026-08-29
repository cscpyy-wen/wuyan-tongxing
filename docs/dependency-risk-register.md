# 开发依赖风险登记

最后复核：2026-08-29

## 发布判定

- `pnpm audit:all` 依次执行三个独立范围：根 pnpm 生产依赖图、根 pnpm 完整依赖图和 `deploy/tencent-cloudbase/package-lock.json`。三者都使用 `--audit-level low`，任一进程无法启动、非零退出、非 JSON/缺少计数或任意严重度计数非零都会立即失败关闭。
- `pnpm audit:prod` 也已收紧到 `low`，但它不含根完整开发图；总发布门禁必须使用 `audit:all`，不得用 `audit:prod` 代替。
- H5 体积门禁按未压缩构建文件计量：单文件上限为 384 KiB，完整 H5 包上限仍为 2 MiB。当前入口 `app.js` 约 342 KiB，因而保留余量但不取消门禁；依赖或入口增长后必须持续在 CI 中核验，超过任一上限即失败。
- Android 构建必须通过 Gradle 8.14.3 wrapper/distribution 与 wrapper JAR 固定哈希、严格依赖验证和运行时/构建脚本锁定。当前 CycloneDX 是 773 个去重组件的平面集合，没有 `dependencies` 依赖边图；773/773 同时具有哈希和声明许可证只表示这些字段存在，不能据此推断可达性或依赖路径。
- Gradle verification metadata 当前使用构件 checksum 且 `verify-signatures=false`。checksum pinning 可以阻止与已记录字节不一致的依赖被静默接受，但没有独立认证 Maven/Gradle 发布者身份，也不是供应商签名或 provenance。
- `scripts/audit-sbom-osv.mjs` 按当前 SBOM 批量查询 722 个 npm 与 51 个 Maven PURL，并把查询时间、SBOM SHA-256 和结果写入 `docs/osv-audit.json`；任一发现或网络/协议错误均失败关闭。

## 当前状态

2026-08-29 的记录显示根生产/完整依赖图和腾讯 CloudBase 部署 npm 锁均为 0 个已知漏洞，SBOM 的 npm/Maven OSV 点时查询也为 0 个已知发现。该结论只覆盖查询时的注册表/OSV 数据库、当前锁文件、PURL 与查询工具语义；不能证明没有未知、尚未入库或因标识不匹配而漏报的漏洞，也不证明最终 APK reachability、上游制品真实性或许可证法律合规。每次锁文件、SBOM、查询数据库或发布版本更新都必须重跑闸门，不得沿用旧结论。
