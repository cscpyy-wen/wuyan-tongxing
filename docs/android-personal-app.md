# Android 版构建、安装与信任边界

当前应用版本为 `0.1.0-personal.31`，基础包名为 `cn.wuyantongxing.personal`，最低 Android 15（API 35），目标 Android 16（API 36）。设计目标包括小米澎湃 OS 3，但公开证据只覆盖 Android 16 模拟器；真实小米设备的安装提示、系统分享、通知、电量策略、大字号和覆盖升级仍需人工复核。

## 两种构建身份

公开仓库把社区构建与维护者正式签名严格分开：

| 命令 | 包名/签名 | 用途 |
| --- | --- | --- |
| `pnpm build:android` | `cn.wuyantongxing.personal.debug` / Android Debug 证书 | 社区开发、模拟器和个人测试 |
| `pnpm build:android:maintainer-release` | `cn.wuyantongxing.personal` / 固定维护者证书 | 仅维护者生成 GitHub Release 候选 |

社区调试包不读取私有签名配置，不能覆盖官方安装包，也不能被描述为官方发布。维护者构建在私钥缺失、证书不匹配或供应链门禁失败时必须停止；签名私钥、口令和本机路径永远不提交到 Git。

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

1. 从本仓库对应版本的 GitHub Release 下载 APK 与 `SHA256SUMS.txt`。
2. 在受信任的终端校验 APK SHA-256；`v0.1.0-personal.31` 的预期值为 `e7da2a22397be89e05048acf2b022f2028cb9447d6e9e011eab6c6e25571c7a0`。
3. 如需进一步核验，使用 Android Build Tools 的 `apksigner verify --print-certs`；预期签名证书 SHA-256 为 `b0fdad152952a3c3c7c97fb214ac1a9b392cfaf7c160c55b40cf6eaa680bf1d7`。
4. 把 APK 传到手机，在系统文件管理器中打开，并只为该来源临时允许“安装未知应用”。安装完成后可关闭这项授权。

不要仅凭文件名判断来源。第三方 fork 可合法修改源码并自行签名，但不能使用本项目维护者的官方身份；其二进制应使用不同包名或清楚标注社区构建。

## 本地数据与更新

- 首次打开无需登录，也不要求联网。
- 戒烟记录保存在 Android 应用沙箱；系统备份和设备迁移关闭。
- Manifest 不声明 `INTERNET`，不申请通讯录、精确位置、相机、麦克风或广域存储权限。
- 数据导出与恢复通过 Android 系统文件选择器完成；应用不会自动上传导出文件。
- 本机提醒为可选能力。拒绝通知权限不影响核心流程。
- 网页版、社区 debug 包和官方包具有独立本地存储，记录不会自动互通。

升级官方包时不要先卸载旧版。只有包名、签名证书一致且 `versionCode` 提高的 APK 才能覆盖安装并保留数据。升级前建议先在应用内导出本机数据副本。卸载、系统“清除数据”或应用内确认删除都会移除本机记录。

## 已验证与未验证

已完成的工程验证包括：离线本地资源、无 `INTERNET` 权限、导出/恢复契约、返回键关闭浮层、SOS 不误写事件、通知降级、基础无障碍自动化、Android 16 模拟器安装与冷启动。

以下结论不能由公开源码或 CI 自动推出：

- 小米澎湃 OS 3 实体机兼容性；
- 真实系统安全扫描结果；
- TalkBack、大字号和低性能真机体验；
- 任一 fork 的 APK 是否与其公开源码一致；
- `v0.1.0-personal.31` 能否从公开快照逐字节复现。

该版本 APK 来自公开前已审查的个人构建。公开源码快照随后补充了开源许可证、社区构建边界和去身份化文档，因此 Release 说明必须准确标注：功能源码对应 v31，但不声称由 GitHub 受控构建器从标签逐字节复现。APK、校验和、SBOM、NOTICE 和第三方许可证包应作为同一 Release 的相邻附件发布。
