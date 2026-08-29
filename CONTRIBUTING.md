# 参与贡献

感谢你帮助改进“无烟同行”。本项目是个人维护的开源戒烟行为支持工具，不提供诊断、处方、个体化用药剂量或疗效保证。

## 选择正确的渠道

- 可复现的普通缺陷：使用 [缺陷报告表单](https://github.com/cscpyy-wen/wuyan-tongxing/issues/new?template=bug.yml)。
- 新功能或改进建议：使用 [功能建议表单](https://github.com/cscpyy-wen/wuyan-tongxing/issues/new?template=feature.yml)。
- 安全漏洞、意外泄露或任何敏感信息：阅读 [安全政策](SECURITY.md)，并使用 [GitHub 私密漏洞报告](https://github.com/cscpyy-wen/wuyan-tongxing/security/advisories/new)。不要公开披露。

提交前请先搜索已有 Issue 和 Pull Request，并尽量把一次变更限定为一个可审查的问题。

## 隐私与测试数据

不得在 Issue、Pull Request、提交历史、测试夹具、日志、截图或演示中加入：

- 真实戒烟记录、健康信息、导出/恢复文件或其他可识别个人的数据；
- token、密码、AppID/AppSecret、API 密钥、签名材料、私钥或其他凭证；
- 可识别真实个人、设备或内部基础设施的信息。

复现和测试只能使用人工构造、不可关联到真实个人的数据。若误提交了敏感信息，请停止公开讨论，通过私密报告说明；泄露的凭证还必须立即撤销或轮换，删除最新提交并不能清除 Git 历史、fork 或缓存。

## 开发流程

1. Fork 仓库，从默认分支创建范围单一的分支。
2. 使用仓库声明的 Node.js 与 pnpm 版本安装依赖：`pnpm install --frozen-lockfile`。
3. 完成最小必要变更，同时更新相关测试和文档；不要提交生成缓存、真实数据或本地凭证。
4. 至少运行与变更相关的检查，并在 Pull Request 中记录命令与结果。
5. 填写 Pull Request 模板，说明行为变化、风险、验证范围和未验证事项。

常用检查：

```text
pnpm typecheck
pnpm test
pnpm verify:repo
pnpm verify:content
pnpm audit:evidence
```

代码变更通常应运行类型检查和相关测试；内容变更应运行 `pnpm verify:content` 与 `pnpm audit:evidence`。跨模块或发布相关变更可能需要运行更完整的 `pnpm verify`。不要把未运行的检查标为通过。

## 医学与健康内容

任何新增或修改的医学、健康或戒烟干预内容都必须随变更附上可核查证据，并清楚标明证据支持的具体主张和边界：

- 优先使用现行权威指南、系统综述或同行评议研究，提供标题、发布机构或作者、版本或发布日期、稳定链接或标识符；
- 按适用范围同步更新 `packages/content/src/data/evidence-sources.json`、`packages/content/src/data/claim-matrix.json` 及相关内容文件；
- 区分一般教育信息与个体化医疗建议，不新增诊断、处方、个体化剂量或疗效保证；
- 不得把“已引用来源”“测试通过”或“内容校验通过”表述为已经完成医学审核、获得机构认可或具备医疗器械资格。

引用外部材料不代表其作者、机构或发布者认可本项目，也不会自动把外部材料重新许可给本项目。只提交必要的原创表述；如必须使用第三方材料，应说明来源、适用许可证和归属。

## 出站许可（按目标路径）

本仓库不是把每个文件同时置于两种许可证下，而是按内容和目标路径适用不同的出站许可：

- 原创软件源代码、配置和测试，以及 `apps/android-shell/android/app/src/main/res/drawable/ic_launcher_foreground.xml` 与 `deploy/tencent-cloudbase/assets/favicon.svg` 两个项目原创视觉资源，默认采用 [Apache License 2.0](LICENSE)。该版权许可不授予商标权，也不允许暗示认可。
- `packages/content/src/data` 中的原创教育内容，以及 `docs` 中的原创叙事性文档，采用 [Creative Commons Attribution 4.0 International](LICENSE-CONTENT.md)。
- `apps/android-shell/android` 中源自 Capacitor Android template 的部分继续采用 [MIT License](apps/android-shell/android/LICENSE-CAPACITOR)，并保留 Drifty Co. 的上游归属。
- `packages/git-clone-safe` 继续采用该目录内声明的 ISC 许可证，并保留上游归属。
- 单独标注许可的文件、第三方组件和第三方材料仍适用其各自条款；详见 `NOTICE` 与 `THIRD_PARTY_NOTICES.md`。

提交贡献即表示你确认：你拥有提交该内容并授予相应权利的权限；你的贡献可按其目标路径适用的上述许可证分发；你不会删除必须保留的版权、许可证或归属声明。若你无权作出这些确认，请不要提交该内容。

## 审查标准

维护者会重点检查变更是否范围清晰、可复现、经过适当验证、保护隐私、保留许可归属，并符合 [行为准则](CODE_OF_CONDUCT.md)。维护者可能要求拆分变更、补充测试或证据，或拒绝不符合安全、医学边界和许可要求的贡献。
