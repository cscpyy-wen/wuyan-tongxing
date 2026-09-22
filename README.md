# 无烟同行

[![CI](https://github.com/cscpyy-wen/wuyan-tongxing/actions/workflows/ci.yml/badge.svg)](https://github.com/cscpyy-wen/wuyan-tongxing/actions/workflows/ci.yml)

无烟同行是一款面向 Android 15 及以上设备的开源、离线优先戒烟记录与行为支持 App。无需注册或登录，逐支记录、统计分析、烟瘾急救、戒烟计划和数据备份均可在本机完成。

[下载 v33 Android APK](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/wuyan-tongxing-personal-0.1.0-personal.33.apk) · [查看 v33 发布说明](docs/releases/v33.md) · [GitHub Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.33)

> 用户已确认在 Xiaomi 15 Pro（Xiaomi HyperOS 3）测试过包含本轮修复的前轮 debug 候选。该实测对象不是 v33 正式签名 APK；候选身份、工程验证和正式发布验证状态见 [v33 发布说明](docs/releases/v33.md)。单台真机结果不等同于所有 Android 手机的兼容性保证。

## 日常怎么用

1. 首次打开时选择直接戒断或限期减量，设定戒烟日、戒烟理由和常见诱因。
2. 每次吸烟时点击首页中央的“我吸了一支烟”，选择原因和 1–5 级烟瘾强度；时间会自动记录。
3. 烟瘾上来但还没吸烟时，点击 SOS，立即开始呼吸、烟瘾冲浪、换场景或查看戒烟理由。
4. 在“记录”查看当天支数、时间、间隔和原因；在“进展”查看连续无烟、少吸支数和阶段任务。
5. 完成首次设置后，可在“我的 → 快捷记录”添加桌面小组件或控制中心“记录一支”磁贴，一次点击记录当前时间，无需填写原因和强度。

## 主要功能

### 一键记录每一支烟

- 首页中央的大按钮单手即可触达。
- 自动保存北京时间，不需要再手工填写全天支数。
- 提供 11 种结构化原因：工作疲惫、刚吃完饭、拉屎、压力或烦躁、社交需要、饮酒后、健身后、无聊或独处、早晨习惯、咖啡或茶、下意识习惯。
- 同时记录 1–5 级烟瘾强度；误记后可以编辑或撤销。

### 桌面与锁屏下拉快捷记录

- 桌面小组件分两行显示今日支数和距上一支的计时，点击整张卡片即可记录一支。
- 控制中心“记录一支”磁贴提供同样的一键记录；手机允许锁屏下拉控制中心时，可从锁屏使用。
- 快捷记录的原因与烟瘾强度留空，回到 App 后可只改时间，也可补全详情。
- 小组件读取主记录和待合并队列并去重，删除的记录不会因残留队列重新计入。

小米桌面手动添加路径、计时规则及锁屏设置限制见[快捷入口说明](docs/android-personal-app.md#桌面小组件与锁屏下拉入口)。深度休眠时，小组件的跨日刷新可能延迟至系统允许执行。

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

| 项目 | v33 发布身份 |
| --- | --- |
| 版本 | `0.1.0-personal.33`（versionCode 33） |
| 包名 | `cn.wuyantongxing.personal` |
| 最低系统 | Android 15（API 35） |
| 目标系统 | Android 16（API 36） |
| APK SHA-256 | 见同一 Release 的 [SHA256SUMS.txt](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/SHA256SUMS.txt) |
| 签名证书 SHA-256 | `b0fdad152952a3c3c7c97fb214ac1a9b392cfaf7c160c55b40cf6eaa680bf1d7` |

安装步骤：

1. 从[官方 GitHub Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.33)下载 APK，并按同一 Release 的 `SHA256SUMS.txt` 核验；如手机无法直接访问，可先在电脑下载，再通过数据线或小米互传发送到手机。
2. 用系统文件管理器打开 APK，只为当前文件来源临时允许“安装未知应用”。
3. 安装完成后可关闭该来源的安装授权。

从旧版更新时：

1. 建议先在 App 内导出一份数据备份。
2. 直接安装新版覆盖旧版，**不要先卸载，也不要清除应用数据**。
3. 如果 Android 提示签名冲突，请停止安装；不要通过卸载旧版来绕过，否则本机记录会丢失。

官方包使用相同包名和固定签名，正常更新应直接覆盖安装。社区 debug 包使用独立包名，其数据不会自动合并到正式包。v33 本轮覆盖升级验证见同一 Release 的 [QA_REPORT.md](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/QA_REPORT.md)。

历史证据：v31→v32 的正式同签名覆盖升级和数据保留已在 Android 16 模拟器完成验证。v32 新增了 `toilet`（“拉屎”）结构化原因；写入该值后，不支持强制降级到 v31 再读取同一份状态。

## 真机与工程验证

| 环境 | 验证方式 | 结果 |
| --- | --- | --- |
| Xiaomi 15 Pro / Xiaomi HyperOS 3 | 用户测试前轮 debug 候选 | 用户已确认；不是 v33 正式签名 APK 的安装验证 |
| Android 16（API 36）模拟器 | 前轮 debug 候选的快捷记录、计时、编辑、确认竞争、横屏和大字号复验 | 已完成；候选身份及实际操作见[审查记录](docs/android-audit-2026-09-22.md) |
| 前轮自动化 | 浏览器端到端、原生 JVM、最终 debug APK instrumentation | 分别为 45/45、43/43、40/40 |
| 本轮隔离 Android 目录 | 工作区、发布脚本、浏览器端到端、原生 JVM 测试 | 分别为 438/438、102/102、45/45、43/43；原生 debug 与测试 APK 构建成功 |
| 本轮依赖检查 | 三张依赖图 low 阈值审计、OSV 扫描 | 三图 0 已知漏洞；OSV 扫描 npm 722 + Maven 51，共 773 项，0 发现 |
| v33 正式签名 APK | 签名、覆盖升级、设备与公开下载核验 | 见同一 Release 的 [QA_REPORT.md](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/QA_REPORT.md) 与 [build-info-public.json](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/build-info-public.json) |

v33 修复日终确认的过时提交、连续无烟时长、非法备份、原生快捷队列和横屏/大字号问题，并更新受安全通告影响的依赖。前轮测试结果不替代本轮正式包的发布门禁。自动化验证和单台真机实测不能保证所有厂商、系统版本与电量策略下绝无兼容性问题；如遇问题，请提交[缺陷报告](https://github.com/cscpyy-wen/wuyan-tongxing/issues/new?template=bug.yml)。

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
- 发布构件、SBOM 与第三方许可证：[v0.1.0-personal.33 Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.33)。

原创软件源码、配置和测试采用 [Apache License 2.0](LICENSE)；原创戒烟教育内容与叙述性文档采用 [CC BY 4.0](LICENSE-CONTENT.md)；派生模板和第三方组件继续适用各自许可证，详见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
