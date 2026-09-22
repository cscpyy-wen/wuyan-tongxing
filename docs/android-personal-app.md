# Android 版构建、安装与信任边界

v33 的发布版本为 `0.1.0-personal.33`（versionCode 33），正式包名为 `cn.wuyantongxing.personal`，最低 Android 15（API 35），目标 Android 16（API 36）。本版加入桌面小组件和锁屏下拉快捷记录，并包含确认竞争、连续无烟时长、导入、原生队列、横屏/大字号及安全依赖修复，详见[v33 发布说明](releases/v33.md)。

> 用户已确认在 Xiaomi 15 Pro（Xiaomi HyperOS 3）测试过前轮 debug 候选，SHA-256 为 `33cebfcaddcd17bef1091d3cfa629000f8f6e631cac40f652f6e950d91678137`。其包名为 `cn.wuyantongxing.personal.debug`，版本名为 `0.1.0-personal.32-debug`；这不是 v33 正式签名 APK 的安装结论。单台真机结果不等同于所有小米机型、HyperOS 版本或 Android 设备的兼容性保证。

## 两种构建身份

公开仓库把社区构建与维护者正式签名严格分开：

| 命令 | 包名/签名 | 用途 |
| --- | --- | --- |
| `pnpm build:android` | `cn.wuyantongxing.personal.debug` / Android Debug 证书 | 社区开发、模拟器和个人测试 |
| `pnpm build:android:maintainer-release` | `cn.wuyantongxing.personal` / 固定维护者证书 | 仅维护者生成 GitHub Release 候选 |

社区调试包不读取私有签名配置，不能覆盖官方安装包，也不能被描述为官方发布。维护者构建在私钥缺失、证书不匹配或供应链门禁失败时必须停止；签名私钥、口令和本机路径永远不提交到 Git。

维护者构建前必须把 `WUYAN_ANDROID_SIGNING_ROOT` 设置为仓库外的绝对目录。该目录固定包含 `personal-release.p12`、`signing.properties` 和 `certificate.sha256`；构建器解析真实路径并拒绝仓库内目录、文件链接越界、非固定密钥库或与版本化策略不一致的证书指纹。

## 构建社区调试包

要求 Node.js 24、pnpm 11、JDK 21、Android SDK Platform 36 与 Build Tools 36。安装依赖后执行：

```powershell
pnpm install --frozen-lockfile
pnpm build:android
```

默认产物：

```text
apps/android-shell/android/app/build/outputs/apk/debug/app-debug.apk
```

脚本会校验产物必须带 `.debug` application ID 后缀、`-debug` 版本后缀，并使用 Android Debug 证书。公开 CI 只验证这条不需要秘密的路径。

## 安装 GitHub Release 中的官方 APK

1. 从本仓库的 [v33 GitHub Release](https://github.com/cscpyy-wen/wuyan-tongxing/releases/tag/v0.1.0-personal.33) 下载 APK 与 [SHA256SUMS.txt](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/SHA256SUMS.txt)。
2. 在受信任的终端按同一 Release 中的 `SHA256SUMS.txt` 校验 `v0.1.0-personal.33` APK 的 SHA-256。
3. 如需进一步核验，使用 Android Build Tools 的 `apksigner verify --print-certs`；预期签名证书 SHA-256 为 `b0fdad152952a3c3c7c97fb214ac1a9b392cfaf7c160c55b40cf6eaa680bf1d7`。
4. 把 APK 传到手机，在系统文件管理器中打开，并只为该来源临时允许“安装未知应用”。安装完成后可关闭这项授权。

不要仅凭文件名判断来源。第三方 fork 可合法修改源码并自行签名，但不能使用本项目维护者的官方身份；其二进制应使用不同包名或清楚标注社区构建。

## 桌面小组件与锁屏下拉入口

这两个入口只在 Android 原生包中提供，使用前必须先打开 App，完成首次设置、敏感健康信息处理同意并建立当前戒烟计划。

添加桌面入口：

1. 打开“我的 → 快捷记录 → 桌面小组件”；若系统弹出面板，在面板中确认添加。“已发送添加请求”只表示已调用系统接口，不代表确认面板出现或添加完成。
2. 如果系统没有弹出面板，点该入口下的“没有弹窗？查看手动添加方法”。小米手机可按“桌面双指捏合 → 添加小部件 → 搜索 → 安卓小部件 → 无烟同行 → 记录一支烟”添加。其他桌面通常可长按空白处进入小组件列表，再添加或拖到桌面。小米路径依据[官方 HyperOS 小部件设计规范](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1664)，具体文字随桌面版本变化。
3. 小组件上方大数字显示当前计划的今日支数，下方显示距上一支的计时（不足一小时为 `分:秒`，超过一小时为 `时:分:秒`）。整张卡片都可点击，成功后总数增加、计时重新开始，不再显示固定的“已记录 1 支”。无历史记录时，计时显示 `—:—`。

统计按北京时间划分“今日”，同时读取 App 内记录与尚未合并的快捷队列，按 UUID 去重。系统 Chronometer 在桌面持续计时，App 不需要常驻；原生数据落盘、系统时间变化和桌面更新会重新计算。午夜使用不唤醒设备的普通系统闹钟刷新日期，并保留每 30 分钟的系统兜底刷新，深度休眠时跨日更新可能延迟至系统允许执行。外观自动适应浅色/深色主题。旧组件可直接更新；如旧尺寸过扁，可长按调整大小或重新添加 2×2 卡片。

添加锁屏可达入口：

1. 打开“我的 → 快捷记录 → 锁屏下拉入口”，在系统面板中确认添加。
2. 如果系统没有弹出面板，打开控制中心编辑页，手动加入“记录一支”磁贴。
3. 只有手机允许在锁屏状态下拉控制中心时，才能不解锁直接点击。不同 HyperOS、桌面和锁屏设置的行为可能不同。

这里的“锁屏下拉入口”是 Android Quick Settings 磁贴，不是 HyperOS 锁屏底部或侧边快捷键。工程同时声明了 App Widget 的 `keyguard` 类别，但是否提供锁屏小组件宿主完全由系统决定，不能据此承诺 Xiaomi 15 Pro 一定出现锁屏小组件位置。

每次点击只生成事件 UUID、当前 UTC 时间、当前戒烟尝试 ID 和入口类型；原因与烟瘾强度有意留空。事件先写入 Android 应用私有目录中的有界队列，打开 App 后才幂等并入主记录并按 UUID 原子确认。删除、备份恢复或导入事务进行中会拒绝快捷写入，不会显示虚假的成功结果；队列达到上限或存储异常时会提示打开 App 处理。

打开 App 后，既有快捷记录可以只修改时间，不必补填原因和强度；如决定填写详情，原因和强度必须成对填写。已有完整详情的记录不能通过编辑清空详情。原生统计同时应用删除墓碑，防止已删除的记录被尚未确认清理的队列再次计入；异常身份字段会拒绝继续写入并保留原值，避免静默修正损坏数据。

## 本地数据与更新

- 首次打开无需登录，也不要求联网。
- 戒烟记录保存在 Android 应用沙箱；系统备份和设备迁移关闭。
- Manifest 不声明 `INTERNET`，不申请通讯录、精确位置、相机、麦克风或广域存储权限。
- 数据导出与恢复通过 Android 系统文件选择器完成；应用不会自动上传导出文件。
- 本机提醒为可选能力。拒绝通知权限不影响核心流程。
- 社区 debug 包和官方包具有独立应用身份与本地存储，记录不会自动互通。

升级官方包时不要先卸载旧版。只有包名、签名证书一致且 `versionCode` 提高的 APK 才能覆盖安装并保留数据。升级前建议先在应用内导出本机数据副本。遇签名冲突应停止安装，不要通过卸载绕过。卸载、系统“清除数据”或应用内确认删除都会移除本机记录。debug 候选与正式包并存时，更新正式包不会自动迁移或合并 debug 包里的记录。

历史上，v31→v32 的同签名覆盖升级与数据保留已在 Android 16 模拟器验证；这不替代本轮 v33 的升级检查。v32 新增了 `toilet`（“拉屎”）结构化原因；写入该值后，不支持通过调试工具强制降级到 v31 后继续读取同一份状态。Android 正常安装流程本来也会拒绝较低 `versionCode` 覆盖较高版本。

## 已验证与未验证

前轮 debug 候选完成了 Android 16 模拟器上的快捷记录、持续计时、只改时间、过时确认拒绝、横屏按钮与大字号人工复验。前轮浏览器端到端为 45/45、原生 JVM 为 43/43、最终 debug APK instrumentation 为 40/40；Lint 为 0 errors / 11 warnings。具体候选、执行范围与原始记录见[2026-09-22 审查文档](android-audit-2026-09-22.md)。用户随后确认测试过同一 debug 候选的 Xiaomi 15 Pro / Xiaomi HyperOS 3 真机版本。

本轮隔离 Android 发布目录已实跑工作区 438/438、发布脚本 102/102、浏览器端到端 45/45、原生 JVM 43/43，原生 debug 与测试 APK 构建成功。工作区比前轮 440 项少 2 项专属 Harmony CSS 测试，发布脚本检查排除了未公开的 Harmony 专属脚本测试，未削减 Android 测试范围。根生产图、完整图与 Tencent 锁文件均通过 low 阈值的 0 已知漏洞门禁；OSV 扫描 npm 722 项与 Maven 51 项，共 773 项，0 发现。

本轮 144 个共享 client 文件与已测源码逐字节相同，50 个界面资源与用户测过的 debug APK 中对应资源的哈希全部相同。该比对支持源码与界面资源的一致性，不把两种包身份等同。详细证据见[v33 发布说明](releases/v33.md)；正式签名、覆盖升级、最终 APK 设备验证与公开下载核验以同一 Release 的 [QA_REPORT.md](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/QA_REPORT.md) 和 [build-info-public.json](https://github.com/cscpyy-wen/wuyan-tongxing/releases/download/v0.1.0-personal.33/build-info-public.json) 为准。

以下结论不能由公开源码或 CI 自动推出：

- 其他小米机型、其他 HyperOS 版本以及其他厂商实体机的兼容性；
- v33 正式签名 APK 已在 Xiaomi 15 Pro 完成安装与逐项验收；前轮 debug 候选的用户实测不能代替这一结论；
- 所有设备都提供相同的小组件固定面板、锁屏下拉设置或锁屏磁贴行为；
- 真实系统安全扫描结果；
- TalkBack、大字号和低性能真机体验；
- 任一 fork 的 APK 是否与其公开源码一致；
- 任意第三方环境能否逐字节复现维护者签名的 `v0.1.0-personal.33` APK。

正式发布流程应从干净的 `v0.1.0-personal.33` 标签提交构建，并在 Release 的公开构建信息中记录实际提交、工作树状态、源码快照摘要、签名证书与 APK 摘要。最终 APK 摘要以同一 Release 的 `SHA256SUMS.txt` 为准，不把构建产物摘要写回其自身的源码快照。由于维护者私钥和本机签名过程不公开，本项目不宣称第三方可逐字节复现签名 APK。APK、校验和、源码归档、SBOM、NOTICE 和第三方许可证包必须作为同一 Release 的相邻附件发布。
