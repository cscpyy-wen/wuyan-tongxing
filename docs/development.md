# Android 开发指南

本文面向参与开发、测试和维护发布的人。安装和日常使用请看[使用指南](user-guide.md)，可下载版本以 [GitHub Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/latest) 为准。

## 开发环境

- Node.js `>=24.14.1 <25`
- pnpm `11.19.0`
- JDK 21
- Android SDK Platform 36 与 Build Tools 36

版本约束以仓库 `package.json`、`.node-version` 和 Android 构建配置为准。首次贡献前，请完整阅读[贡献约定](../CONTRIBUTING.md)与[安全政策](../SECURITY.md)；测试只使用合成数据，不提交真实健康记录或签名凭据。

## 构建社区调试包

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build:android
```

默认输出：

```text
apps/android-shell/android/app/build/outputs/apk/debug/app-debug.apk
```

社区包使用 `cn.wuyantongxing.personal.debug` 与 Android Debug 证书，不能覆盖官方安装包。它与正式包分别保存数据，不会自动互通。

项目正式包使用 `cn.wuyantongxing.personal`。维护者签名材料必须从仓库外注入；缺少签名材料、证书不匹配或门禁失败时，正式构建必须停止。具体流程复用[Android 构建与信任边界](android-personal-app.md#两种构建身份)，不在本文复制私有环境配置。

## 验证修改

常用检查：

```powershell
pnpm typecheck
pnpm test
pnpm verify:repo
pnpm test:release
pnpm test:android:native
```

客户端交互变更还应运行相关端到端测试。修改健康教育内容时，按贡献约定补齐来源，并执行 `pnpm verify:content` 与 `pnpm audit:evidence`。不要把未运行的检查写成通过。

设备测试必须选择专用模拟器或测试设备，显式设置 `ANDROID_SERIAL` 后运行 `pnpm test:android:native:device`。覆盖升级前保存测试数据副本；不得通过卸载或清空数据“验证”数据保留。

## 安装包核验

从同一 Release 下载 APK 与 `SHA256SUMS.txt`，在电脑上计算 APK 的 SHA-256，并与清单对应条目比较：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '下载的安装包.apk'
```

需要检查签名时，使用 Android Build Tools 的 `apksigner verify --print-certs`。官方签名证书 SHA-256 为：

```text
b0fdad152952a3c3c7c97fb214ac1a9b392cfaf7c160c55b40cf6eaa680bf1d7
```

文件名不能证明来源。版本、实际提交、源码快照、APK 摘要和验证范围应以该次 Release 的 `build-info-public.json`、`SHA256SUMS.txt` 与 `QA_REPORT.md` 为准。

## 正式发布与验证边界

维护者应按[Android 发布流程](android-personal-app.md)和[运维手册](operations-runbook.md)执行供应链、构建、签名、升级与设备检查，确认目标提交的 CI 成功后，再核对公开 Release 的标签、状态和附件，并从公开下载地址重新核验 APK 摘要。

正式 APK、校验清单、源码归档、SBOM、NOTICE 和第三方许可证包应在同一 Release 提供。构建成功、候选可安装或用户反馈良好，都不能单独证明正式发布已完成。模拟器检查、单台真机使用反馈与医学疗效是不同的证据范围。

本项目不宣称第三方能逐字节复现维护者签名 APK。旧文档中的版本号、测试数量和扫描结果仅描述其对应轮次，不自动适用于后来版本；现有 Android 专题文档中的 v33 内容应按历史版本阅读。

## 文档索引

| 主题 | 文档 |
| --- | --- |
| 安装与日常使用 | [使用指南](user-guide.md) |
| Android 构建、签名、快捷记录原理 | [Android 专题说明](android-personal-app.md) |
| 贡献与安全报告 | [贡献约定](../CONTRIBUTING.md)、[安全政策](../SECURITY.md) |
| 版本变化 | [CHANGELOG](../CHANGELOG.md)、[v33 发布说明](releases/v33.md) |
| 无烟首页计算与来源 | [指标证据矩阵](quit-dashboard-evidence.md)、[2026-10-13 候选验证记录](quit-dashboard-validation-2026-10-13.md) |
| 数据与风险 | [隐私数据地图](privacy-data-map.md)、[威胁模型](threat-model.md) |
| 健康内容维护 | [主张与证据矩阵](content-claims-matrix.md)、[证据目录](content-evidence-catalog.md)、[医学审核清单](medical-review-checklist.md) |
| 测试与维护 | [QA 计划](qa-plan.md)、[运维手册](operations-runbook.md)、[交付矩阵](industrial-delivery-matrix.md) |
| 第三方依赖与许可 | [第三方声明](../THIRD_PARTY_NOTICES.md)、[依赖风险登记](dependency-risk-register.md) |

仓库还保留内部测试与其他平台的架构资料；它们不代表已对普通用户开放相应服务或完成原生平台验收。
