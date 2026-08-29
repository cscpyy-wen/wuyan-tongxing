# 无烟同行

[![CI](https://github.com/cscpyy-wen/wuyan-tongxing/actions/workflows/ci.yml/badge.svg)](https://github.com/cscpyy-wen/wuyan-tongxing/actions/workflows/ci.yml)

无烟同行是一款面向中国大陆成年纸烟用户的开源、离线优先戒烟行为支持工具。项目包含 H5、微信小程序源码、Android 客户端、共享领域包和本地开发用 API/管理后台。

> **重要医疗边界**
>
> 本项目不是医疗器械，不提供诊断、处方、个体化用药剂量或疗效保证。医学内容是带来源的工程草案，尚未完成具名医学审核，不能替代医生、戒烟门诊或紧急医疗服务。急性胸痛、严重呼吸困难或自伤风险应立即联系当地急救和人工专业服务。

## 当前版本

- 公开源码快照：`0.1.0-personal.31`
- Android 包名：`cn.wuyantongxing.personal`
- Android 最低版本：Android 15（API 35）
- Android 目标版本：Android 16（API 36）
- 当前验收边界：Android 模拟器 `emulator-5554`；尚未声称通过小米实体机或 HyperOS 3 真机验收

官方签名 APK 发布在 [GitHub Releases](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.31)，不提交进源码主分支。

| 校验项 | `v0.1.0-personal.31` |
| --- | --- |
| APK SHA-256 | `e7da2a22397be89e05048acf2b022f2028cb9447d6e9e011eab6c6e25571c7a0` |
| 签名证书 SHA-256 | `b0fdad152952a3c3c7c97fb214ac1a9b392cfaf7c160c55b40cf6eaa680bf1d7` |

## 主要能力

- 首页一键记录“我吸了一支烟”，选择原因和烟瘾强度，自动保存时间。
- 按天统计支数、间隔、时段和诱因，不要求用户再次手工填写全天支数。
- 中央 SOS 急救入口，提供呼吸、烟瘾冲浪、换场景、戒烟理由和伙伴支持。
- 直接戒断和限期减量两条路径，包含准备、28 天日程、巩固和长期随访。
- 滑倒后重算当前连续无烟时间，但不清空累计进展和历史尝试。
- Android 版无需账号，首次启动可离线；运行时不声明 `INTERNET` 权限。
- 本机提醒、系统分享、JSON 导出与恢复均由用户主动触发。

## 隐私设计

Android 个人版的核心记录默认只保存在应用私有目录：

- 不要求 OpenAI、微信、手机号或小米账号登录。
- 不申请通讯录、精确位置、相机、麦克风或广域存储权限。
- 不包含真实广告、支付、社区、私信或生成式 AI。
- 导出与恢复使用 Android 系统文件选择器；卸载或清除应用数据会删除本机记录。
- 仓库不包含真实戒烟记录、用户导出文件、云端密钥或 Android 私钥。

完整数据边界见 [隐私数据地图](docs/privacy-data-map.md) 和 [威胁模型](docs/threat-model.md)。

## 开始开发

要求：

- Node.js `>=24.14.1 <25`
- pnpm `11.19.0`
- Android 构建需要 JDK 21 和 Android SDK 36

```powershell
corepack enable
pnpm install --frozen-lockfile
```

### H5

```powershell
pnpm build:h5
pnpm serve:h5
```

浏览器打开 `http://127.0.0.1:4173/#/pages/onboarding/index`。

### Android 社区调试包

```powershell
pnpm build:android
```

该命令生成带 `.debug` application ID 后缀的调试 APK，不需要维护者私钥，也不能覆盖官方签名安装包。默认输出位于：

```text
apps/android-shell/android/app/build/outputs/apk/debug/app-debug.apk
```

维护者的正式签名链使用：

```powershell
pnpm build:android:maintainer-release
```

它会在缺少本机私钥或证书不匹配时失败关闭。私钥、口令和签名配置永远不属于公开仓库。

### 微信小程序

```powershell
pnpm build:weapp
```

将 `apps/client` 导入微信开发者工具。源码默认使用公开测试占位 AppID；真实 AppID、主体、订阅模板和服务器域名需要由部署者自行配置并完成相应审核。

### 国内 H5 包装

```powershell
pnpm build:cn-preview
```

该命令只生成通用静态包，不包含本项目维护者的 CloudBase 环境 ID、域名或部署凭据。部署者必须使用自己的境内环境、域名和合规配置。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm test:release
pnpm verify:content
pnpm verify:repo
pnpm build
pnpm test:e2e
pnpm audit:all
pnpm supply-chain
```

首次运行 Playwright 前执行：

```powershell
pnpm test:e2e:install
```

正式 Android 签名、真实设备 instrumentation、真实微信能力和生产部署属于独立门禁，不能由普通 CI 或 H5 测试替代。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `apps/client` | Taro + React 客户端，生成 H5 和微信小程序 |
| `apps/android-shell` | Capacitor Android 壳层与原生桥 |
| `apps/api` | Fastify + Zod/OpenAPI 本地契约服务 |
| `apps/admin` | 轻量内容管理后台 |
| `apps/worker` | 本地持久任务 Worker |
| `packages/domain` | 戒烟状态、日期和统计核心逻辑 |
| `packages/content` | 版本化教育内容和证据引用 |
| `packages/contracts` | 公共接口类型与校验 |
| `packages/persistence` | PGlite/Drizzle 本地持久化 |
| `packages/platform` | 微信、H5 和本地模拟适配器 |
| `packages/rules` | 声明式白名单规则引擎 |
| `deploy/tencent-cloudbase` | 去身份化的国内静态托管包装 |
| `docs` | 架构、隐私、证据和医学审核边界 |

## 内容与循证边界

内容采用行为支持、诱因识别、烟瘾应对、滑倒恢复和专业转介等循证原则。每条关键主张应在内容证据目录中保留来源、版本和复核状态。

- [内容主张与证据矩阵](docs/content-claims-matrix.md)
- [证据目录](docs/content-evidence-catalog.md)
- [医学审核清单](docs/medical-review-checklist.md)
- [内容覆盖清单](docs/content-coverage.md)

引用外部指南或论文不表示其作者、机构或发布者认可本项目。本仓库只许可项目贡献者拥有权利的原创表达；外部来源仍受各自版权和使用条款约束。

## 参与贡献与安全报告

- 贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 社区行为规范见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 使用 GitHub 私密漏洞报告，不要在公开 Issue 中提交 token、健康记录或导出文件。

## 许可证

- 原创源代码、配置和测试，以及 `apps/android-shell/android/app/src/main/res/drawable/ic_launcher_foreground.xml` 与 `deploy/tencent-cloudbase/assets/favicon.svg` 两个项目原创视觉资源：[Apache License 2.0](LICENSE)
- `packages/content/src/data` 中的原创教育内容及 `docs` 中的原创叙述性文档：[Creative Commons Attribution 4.0](LICENSE-CONTENT.md)
- `apps/android-shell/android` 中源自 Capacitor Android template 的部分：[MIT License，Copyright (c) 2017-present Drifty Co.](apps/android-shell/android/LICENSE-CAPACITOR)
- `packages/git-clone-safe`：该目录内声明的 ISC License
- 第三方组件和素材：仍适用各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[第三方许可证清单](docs/third-party-licenses.json) 和 [CycloneDX SBOM](docs/sbom.cdx.json)

许可证不改变上述医疗边界，也不构成任何机构认可、医学保证或商标授权；视觉资源的版权许可不允许以暗示本项目或贡献者认可的方式使用名称或标识。
