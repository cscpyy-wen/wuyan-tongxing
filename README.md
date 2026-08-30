# 无烟同行

[![CI](https://github.com/cscpyy-wen/wuyan-tongxing/actions/workflows/ci.yml/badge.svg)](https://github.com/cscpyy-wen/wuyan-tongxing/actions/workflows/ci.yml)

无烟同行是一款面向 Android 15 及以上设备的开源、离线优先戒烟记录与行为支持 App。无需注册或登录，逐支记录、统计分析、烟瘾急救、戒烟计划和数据备份均可在本机完成。

[下载最新版 Android APK](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.32/wuyan-tongxing-personal-0.1.0-personal.32.apk) · [查看 v32 发布说明](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.32)

> `v0.1.0-personal.32` 已在 Xiaomi 15 Pro（Xiaomi HyperOS 3）真机完成个人安装与日常使用实测，未发现影响使用的问题。该结果只代表已测试的设备和系统组合，不等同于所有 Android 手机的兼容性保证。

## 日常怎么用

1. 首次打开时选择直接戒断或限期减量，设定戒烟日、戒烟理由和常见诱因。
2. 每次吸烟时点击首页中央的“我吸了一支烟”，选择原因和 1–5 级烟瘾强度；时间会自动记录。
3. 烟瘾上来但还没吸烟时，点击 SOS，立即开始呼吸、烟瘾冲浪、换场景或查看戒烟理由。
4. 在“记录”查看当天支数、时间、间隔和原因；在“进展”查看连续无烟、少吸支数和阶段任务。

## 主要功能

### 一键记录每一支烟

- 首页中央的大按钮单手即可触达。
- 自动保存北京时间，不需要再手工填写全天支数。
- 提供 11 种结构化原因：工作疲惫、刚吃完饭、拉屎、压力或烦躁、社交需要、饮酒后、健身后、无聊或独处、早晨习惯、咖啡或茶、下意识习惯。
- 同时记录 1–5 级烟瘾强度；误记后可以编辑或撤销。

### 自动分析吸烟规律

- 汇总每日支数、吸烟时间、相邻间隔和烟瘾均值。
- 统计高频时段、主要原因及各原因占比。
- 所有统计都来自逐支事件，避免用户凭记忆估算当天总量。

### 戒烟计划与进展

- 支持直接戒断和限期减量两条路径。
- 包含准备任务、28 天日程、第 5–8 周巩固和长期随访。
- 滑倒后重新计算当前连续无烟时间，但不会清空累计进展、任务和历史尝试。
- 省钱、少吸支数和戒烟尝试次数会随记录自动更新。

### SOS 烟瘾急救

- 呼吸练习。
- ACT 烟瘾冲浪。
- 立即换场景。
- 查看自己的戒烟理由。
- 主动联系可信伙伴。

SOS 使用本地内容，未登录、离线或拒绝通知权限时仍可使用。

### 本机工具

- 可选的本机提醒。
- 用户主动触发的系统分享。
- JSON 数据导出与恢复。
- 大字号、横屏、读屏标签和至少 44px 触控目标适配。

## 下载、安装与更新

| 项目 | 当前官方版本 |
| --- | --- |
| 版本 | `0.1.0-personal.32`（versionCode 32） |
| 包名 | `cn.wuyantongxing.personal` |
| 最低系统 | Android 15（API 35） |
| 目标系统 | Android 16（API 36） |
| APK SHA-256 | `842612389777dd99672388cbf5904a9ccf4922789427c61ed180ec314ceb8a16` |
| 签名证书 SHA-256 | `b0fdad152952a3c3c7c97fb214ac1a9b392cfaf7c160c55b40cf6eaa680bf1d7` |

安装步骤：

1. 从[官方 GitHub Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.32)下载 APK；如手机无法直接访问，可先在电脑下载，再通过数据线或小米互传发送到手机。
2. 用系统文件管理器打开 APK，只为当前文件来源临时允许“安装未知应用”。
3. 安装完成后可关闭该来源的安装授权。

从旧版更新时：

1. 建议先在 App 内导出一份数据备份。
2. 直接安装新版覆盖旧版，**不要先卸载，也不要清除应用数据**。
3. 如果 Android 提示签名冲突，请停止安装；不要通过卸载旧版来绕过，否则本机记录会丢失。

v31→v32 的正式同签名覆盖升级和数据保留已在 Android 16 模拟器完成验证。v32 新增了 `toilet`（“拉屎”）结构化原因；写入该值后，不支持强制降级到 v31 再读取同一份状态。

## 真机与工程验证

| 环境 | 验证方式 | 结果 |
| --- | --- | --- |
| Xiaomi 15 Pro / Xiaomi HyperOS 3 | 个人真机安装与日常使用实测 | 未发现影响使用的问题 |
| Android 16（API 36）模拟器 | 完整 Android 回归、冷启动、编辑、统计、离线和覆盖升级 | 通过 |
| Android instrumentation | 指定模拟器原生测试 | 26/26 通过 |
| GitHub Actions | 公开工业验证 | [全部成功](https://github.com/cscpyy-wen/wuyan-tongxing/actions/runs/33294086593) |

v32 还完成了 11 个吸烟原因逐项触控、保存、编辑、撤销、SOS、记录、进展、冷启动持久化和大字号/横屏回归。自动化验证和单台真机实测都不能保证所有厂商、系统版本与电量策略下绝无兼容性问题；如遇问题，请提交[缺陷报告](https://github.com/cscpyy-wen/wuyan-tongxing/issues/new?template=bug.yml)。

## 隐私与本地数据

- 无需注册或登录，也不索取手机号、头像或昵称。
- 官方 Android 包不声明 `INTERNET` 权限，核心流程不需要联网。
- 不申请通讯录、精确位置、相机、麦克风或广域存储权限。
- 戒烟计划和逐支吸烟记录保存在 Android 应用私有目录。
- 导出与恢复使用 Android 系统文件选择器；App 不会自动上传导出文件。
- JSON 导出文件可能包含敏感健康信息，应由用户自行妥善保管。
- 卸载 App、系统“清除数据”或在 App 内确认删除都会移除本机记录；系统备份与设备迁移默认关闭。
- 不包含广告、支付、社区、私信或生成式 AI。

完整边界见[隐私数据地图](docs/privacy-data-map.md)和[威胁模型](docs/threat-model.md)。

## 医疗与循证边界

本项目提供戒烟行为支持、自我记录和一般性教育信息，不是医疗器械，不提供诊断、处方、个体化用药剂量、药品购买或疗效保证。医学内容保留证据来源，但尚未完成具名医学审核，不能替代医生、戒烟门诊或紧急医疗服务。

急性胸痛、严重呼吸困难、自伤风险或其他紧急情况应立即联系当地急救和人工专业服务。引用指南或研究不表示其作者、机构或发布者认可本项目。

- [内容主张与证据矩阵](docs/content-claims-matrix.md)
- [证据目录](docs/content-evidence-catalog.md)
- [医学审核清单](docs/medical-review-checklist.md)

## 构建 Android 调试包

开发环境：Node.js `>=24.14.1 <25`、pnpm `11.19.0`、JDK 21、Android SDK 36。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build:android
```

默认输出：

```text
apps/android-shell/android/app/build/outputs/apk/debug/app-debug.apk
```

社区调试包使用 `cn.wuyantongxing.personal.debug` 和 Android Debug 证书，不能覆盖官方安装包，也不能冒充官方发布。维护者签名流程、APK 核验方法和更新边界见 [Android 构建与安装文档](docs/android-personal-app.md)。

Android 相关检查：

```powershell
pnpm verify:repo
pnpm test:release
pnpm test:android:native
```

连接专用模拟器或测试设备后，设备 instrumentation 需要显式设置 `ANDROID_SERIAL` 并运行 `pnpm test:android:native:device`。

## 开源、贡献与许可证

- 问题和建议：[GitHub Issues](https://github.com/cscpyy-wen/wuyan-tongxing/issues)。
- 贡献流程：[CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全漏洞：[SECURITY.md](SECURITY.md)。
- 发布构件、SBOM 与第三方许可证：[v0.1.0-personal.32 Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.32)。

原创软件源码、配置和测试采用 [Apache License 2.0](LICENSE)；原创戒烟教育内容与叙述性文档采用 [CC BY 4.0](LICENSE-CONTENT.md)；派生模板和第三方组件继续适用各自许可证，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
