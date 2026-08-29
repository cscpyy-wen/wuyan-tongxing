# 微信开发者工具验证边界

记录日期：2026-08-23

## 已完成

- 通过 Windows Package Manager 安装腾讯官方包 `Tencent.WeixinDevTools`。
- 已安装版本：微信开发者工具 `2.02.2608040`。
- CLI `--help` 可正常返回 `open`、`login`、`islogin`、`preview`、`upload` 等官方命令。
- `pnpm build:weapp` 已成功生成最新 `apps/client/dist/weapp`。
- `apps/client/project.config.json` 已配置：
  - `compileType: miniprogram`
  - `miniprogramRoot: dist/weapp/`
  - `appid: touristappid`
  - `libVersion: 3.7.8`
- 导入时 `touristappid` 在当时工具版本返回“系统错误，错误码 1”，因此验证者在自己的 IDE 会话中临时选择工具提供的测试号完成本地编译；公开源码保留 `touristappid`，不包含任何正式 AppID。
- 首次 IDE 运行发现 Zod 4 object JIT 在微信 AppService 环境触发 `a1 is not a function`。客户端规则与计划运行路径已改为显式白名单校验，API/服务端仍保留 Zod 校验；最新微信 JS 产物中 `_zod`、`ZodObjectJIT` 和 `vendor:"zod"` 均为零命中。
- 2026-08-23 20:25（Asia/Shanghai）在 Stable `2.02.2608040`、本地基础库 `3.17.1` 下执行普通编译，页面 `pages/onboarding/index` 正常运行，调试器为 **0 错误、0 警告**。
- 公开仓库不提供带账号状态的原始 IDE 截图。后续提交图证时必须先隐藏头像、账号、AppID、本机路径和其他个人信息。

## 本次验证边界

测试号只证明代码包可被官方工具编译并在模拟器运行，不等同于正式 AppID、体验版或真机能力验证。验证者不应为了自动化关闭 IDE 安全控制，也不应把登录凭据、正式 AppID 或项目私有配置提交到仓库。

因此当前结论是：**Taro 微信目标构建与官方 IDE 本地编译均通过；正式 OpenID、订阅消息发送、真实分享面板、合法域名、体验版、上传与真机离线仍未验证。**

## 获得正式 AppID 后应补录

1. 在本地私有配置中使用有权限的正式 AppID，不把账号专属 ID 或密钥提交到源码。
2. 重新验证合法域名、隐私接口、`wx.login`、订阅消息授权/发送/失败降级和真实分享面板。
3. 在 Android 与 iPhone 真机验证冷启动、离线 SOS、弱网、系统大字号和读屏。
4. 完成体验版分发、上传、备案与公开审核前检查。

## 当前记录与后续项

| 项目 | 记录 |
| --- | --- |
| 开发者工具版本 | Stable 2.02.2608040 |
| AppID 模式 | IDE 测试号；源码恢复为 `touristappid` |
| 编译时间 | 2026-08-23 20:25（Asia/Shanghai） |
| 基础库 | IDE 本地 3.17.1；源码建议值 3.7.8 |
| 控制台 | 0 错误、0 警告；公开仓库不包含账号态原始图证 |
| 首次设置 | 模拟器首屏正常；两条完整路径已由 H5 E2E 覆盖 |
| 离线 SOS | H5 自动化已覆盖；微信真机待 Android、iPhone 补录 |
| 微信能力 | 正式登录、订阅发送、分享、体验版与上传待正式 AppID 验证 |
