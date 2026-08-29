# 依赖兼容性豁免

豁免不是忽略安全公告；只有“上游 peer 范围落后于已修复版本、替代方案风险更高且完整构建/测试通过”时才能登记。新增或扩大豁免必须单独评审。

## WAIVER-2026-08-24-01：Taro 4.2.1 / Webpack

| 字段 | 记录 |
| --- | --- |
| 上游约束 | `@tarojs/webpack5-runner@4.2.1` 将 peer 精确写为 `webpack: 5.91.0` |
| 实际版本 | `webpack 5.104.1` |
| 不采用上游版本的原因 | 5.91.0 命中 GHSA-4vvj-4cpr-p986（中危 DOM clobbering/XSS）及两个低危构建期 SSRF 公告；5.104.1 修复这些范围 |
| 兼容证据 | H5、WeApp 生产构建，客户端单元测试和完整 Playwright 旅程必须持续通过；`pnpm peers check` 仅对该版本范围放行 |
| 运行暴露 | Webpack 是构建工具，不在 H5/WeApp 运行时作为服务器开放；仍需审计最终静态产物 |
| 复核条件 | Taro 升级、Webpack 6、构建错误、新安全公告或最迟下一次正式发布前 |
| 关闭方式 | 升级到正式声明支持已修复 Webpack 的 Taro 版本，并删除 `peerDependencyRules.allowedVersions.webpack` |

## esbuild override

Taro 依赖的 `esbuild 0.21.5` 被根工作区定点覆盖到维护版本，`bundle-require` 的真实 peer 是 `>=0.18`。构建和类型检查均须通过；当 Taro 自身升级到维护版本后删除 override 与相应 peer 说明。
