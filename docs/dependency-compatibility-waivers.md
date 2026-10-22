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

## 2026-10-22：v34 安全升级兼容复核

本轮使用 Node.js 24.14.1、pnpm 11.19.0，按当日注册表和安全通告选择明确版本，不执行强制自动修复或全量 latest 升级。下表是依赖升级记录，不是安全通告豁免或正式发布通过结论。

| 依赖 | 升级 |
| --- | --- |
| fast-uri | 3.1.6 → 3.1.8；4.1.3 → 4.1.5 |
| brace-expansion | 1.1.18 → 1.1.21；2.1.4 → 2.1.7；5.0.9 → 5.0.12 |
| axios / fastify / vm2 | 1.19.0 → 1.20.0 / 5.12.1 → 5.12.5 / 3.11.6 → 3.12.2 |
| seroval / source-map-js / proxy-addr | 1.5.6 → 1.6.3 / 1.2.1 → 1.2.2 / 2.0.7 → 2.0.8 |
| joi / compression | 17.13.6 → 17.13.8 / 1.8.1 → 1.8.2 |
| postcss-selector-parser | 6.1.4、7.1.5 → 7.1.6 |
| shell-quote / follow-redirects / launch-editor | 1.10.0 → 1.11.0 / 1.16.0 → 1.16.1 / 2.14.1 → 2.14.2 |
| webpack-dev-middleware | 7.4.5 → 7.4.6 |
| Vite | 7.3.6 → 7.3.7 |
| Vitest、coverage-v8 及同版本内部组件 | 4.1.11 → 4.1.12 |
| braces | 保留 3.0.3 身份，通过 pnpm 补丁限制嵌套深度 |
| http-cache-semantics | 4.2.0 → 4.3.0，并通过 pnpm 补丁统一缓存复用限制 |

`postcss-selector-parser` 的 [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) 没有已发布的 6.x 修复线，因此定点覆盖到 7.1.6。这是本轮需要重点复核的主版本兼容变更：H5 与 WeApp 生产构建已实际完成，客户端 485 项单元测试通过，完整工作区类型检查、单元测试和 `verify:industrial` 通过。最终端到端、Android 制品和设备验证仍须按正式发布门禁重新执行。

实际锁文件在升级前已使用 Vite 7.3.6；本次仅更新该版本线的补丁，不把 Taro 的旧 Vite 6 peer 豁免扩大到 7。Webpack 继续精确固定在 5.104.1，原 peer 范围和工程断言保持不变；`pnpm peers check` 通过。依赖重新解析同时把 `@types/sass` 与 `scss-bundle` 使用的 Sass 1.83.4 合并到原依赖图已有的 1.103.1；客户端直接使用的 Sass 版本不变。

WeApp 仍输出已记录的 CSS 顺序与构建缓存警告；构建退出码为 0，生成产物通过工程审计。这不替代微信运行环境验收，也不把编译通过视为所有设备兼容。

两份本地补丁通过 `pnpm-workspace.yaml` 的 `patchedDependencies` 正式接入；锁文件绑定补丁 SHA-256。原始包名、上游版本和许可证不改写：`braces@3.0.3` 保留 MIT，`http-cache-semantics@4.3.0` 保留 BSD-2-Clause。4.3.0 原包只提供其上游已有修复，不能单独据此认定 max-stale 问题已消除。具体变更、原始包完整性、安装文件哈希与验证入口见 [braces 补丁记录](security-patches/braces.md) 和 [http-cache-semantics 补丁记录](security-patches/http-cache-semantics.md)。

补丁正式安装后再次通过完整类型检查、565 项工作区单元测试与完整构建；两份补丁在实际安装包上的专项回归分别为 807/807 与 172/172，零跳过。缓存补丁还覆盖合法引号扩展值、重复限制指令、旧缓存对象中的伪造共享授权及 Pragma 大小写/完整指令识别边界。全依赖扫描仍覆盖 low 阈值，原始警报必须保留；发布判定只有在固定包身份、上游完整性、补丁哈希、安装文件和回归全部匹配时，才能将对应记录计为本地已修复。其他发现、证据缺失、证据漂移及查询失败仍须阻断发布。最终 SBOM/OSV、Android 签名制品与设备验收由正式发布门禁统一验证。
