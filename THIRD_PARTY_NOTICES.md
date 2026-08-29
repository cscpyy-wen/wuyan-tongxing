# 第三方软件与许可证说明

本文件由 `pnpm supply-chain` 从锁定的生产依赖图自动生成。机器可读的 CycloneDX SBOM 位于 `docs/sbom.cdx.json`，许可证清单位于 `docs/third-party-licenses.json`；两份文件以 purl 为组件身份，必须通过 `pnpm verify:licenses` 的双向精确集合校验。

## 当前清单

- 生产组件总数：773
- npm 组件：722
- Android `releaseRuntimeClasspath` Maven 组件：51
- 有声明许可证的组件：773
- 无声明许可证的组件：0

| 上游声明的许可证或 SPDX 表达式 | 组件数 |
| --- | ---: |
| `(Apache-2.0 OR MIT)` | 1 |
| `(Apache-2.0 OR MPL-1.1)` | 1 |
| `(MIT OR CC0-1.0)` | 2 |
| `0BSD` | 2 |
| `Apache-2.0` | 90 |
| `Apache-2.0 AND MIT` | 10 |
| `BlueOak-1.0.0` | 2 |
| `BSD-2-Clause` | 20 |
| `BSD-3-Clause` | 20 |
| `CC-BY-4.0` | 1 |
| `CC0-1.0` | 2 |
| `ISC` | 27 |
| `MIT` | 582 |
| `MPL-2.0` | 13 |

## 源代码中的派生模板

`apps/android-shell/android` 的部分文件源自 `@capacitor/cli@8.5.0` 随附的 Capacitor Android template，Copyright (c) 2017-present Drifty Co.，采用 MIT License。完整通知与许可文本位于 `apps/android-shell/android/LICENSE-CAPACITOR`。该派生模板归属不包含已从公开快照删除的 Capacitor 默认标志 PNG。

## 公开 Release 邻接许可证包

维护者运行 `pnpm release:license-pack` 后，会在被 Git 忽略的 `release-assets/` 中得到版本化的 `.tar.gz` 许可证包及其 SHA-256 文件。包内包含本说明、SBOM、逐 purl 许可证清单、逐组件文本来源清单以及实际许可证/NOTICE 文本；它不复制 APK。

上游许可证元数据和文本用于可追溯的工程盘点，不等同于法律意见，也不自动免除署名、NOTICE、源代码提供或再分发义务。公开发布前仍须由负责人员复核新增许可证、素材归属及适用义务；未通过复核不得发布。
