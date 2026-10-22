# 工业交付验收矩阵

状态只使用三类：`PASS` 表示所注明轮次有可复现证据；`SIMULATED` 表示契约/本机路径通过但真实平台未接入；`BLOCKED` 表示外部或生产条件未完成。历史 PASS 不自动继承到新制品。本文不宣称获得 OWASP、WCAG、SLSA、医疗或法律认证。

## 当前 Android v34 发布准备

当前用户产品为本地优先的 Android App；H5、微信、API/Worker 为内部或实验范围。v34 的状态、候选身份和本轮结果见 [v34 发布准备](releases/v34.md)，本文不宣称 v34 已公开，也不将历史测试或前轮真机反馈当作依赖重建后新 APK 的验收。

当前供应链验收要求保留原始 npm/pnpm、OSV 警报，以 **low 阈值下未处置项为 0** 判定。补丁必须保留上游包名/版本/PURL，记录来源和许可；每次门禁核对锁、补丁、回归入口及所有实际安装副本的完整文件集，并逐副本执行回归。未知/变更公告、证据过期、字节不一致、未应用补丁、测试失败/跳过或不完整扫描结果均阻止发布，不能仅凭扫描不报警视为修复。

维护准备使用 `pnpm audit:all --write-report` 保存 `docs/dependency-audit.json`；正式 `pnpm audit:all` 只读检查。OSV 更新与正式实时复查分别为 `pnpm audit:sbom-osv`、`pnpm audit:sbom-osv:check`；正式检查不得自动改写已提交报告。详细规则见[开发指南](development.md#供应链报告与只读门禁)、[依赖风险登记](dependency-risk-register.md)和[补丁证据清单](security-patches/manifest.json)。

## 历史工程证据快照（不代表 v34 本轮通过）

下表保留此前工程轮次的范围与阻断背景，其中测试数量、组件数量和“0 发现”只描述当时结果。Android v33 的对应证据见 [v33 发布说明](releases/v33.md)；Web/API 条目不是 Android 本机存储加密或联网服务已上线的证明。当前验收必须重新运行，不能复制本表 PASS 作为 v34 的结论。

| 领域 | 状态 | 阻断证据/验收证据 |
| --- | --- | --- |
| 免登录本地核心旅程 | PASS | 两条路径、记录、进展、SOS、滑倒、随访、导出/删除的单元与 H5 E2E |
| 离线与降级 | PASS | 成功初始化后断网重载和首次进入 SOS；提醒拒绝/失败降级 |
| 内容完整性 | PASS | 73 条内容、22 个证据来源、18 条主张映射；草案状态强制 |
| 医学正确性签署 | BLOCKED | 尚无具名医学/药学审核人、日期和签名 |
| 无障碍自动化 | PASS | axe 覆盖 WCAG 2.0/2.1/2.2 A/AA、键盘、触控区、溢出与对比度回归 |
| 真机无障碍/大字号/低性能 | BLOCKED | VoiceOver/TalkBack、系统大字号和低端真机人工证据未完成 |
| 实验 API 鉴权、输入、幂等与加密 | PASS | 历史服务端严格 schema、重放冲突、用途隔离 AEAD、越权/限流/篡改回归；不表示 Android JSON 档案或手动导出已加密 |
| 真实微信身份/订阅/分享 | SIMULATED | `touristappid` 与官方 IDE 测试号；正式 AppID、模板和真机未完成 |
| 可选云同步与统计 | SIMULATED | 服务端契约与隔离测试通过；客户端不接 API，开关只保存本地模拟状态 |
| 生产数据库/KMS/备份 | BLOCKED | PGlite 仅限本机；生产 API/Worker 当前无条件失败关闭，PostgreSQL、KMS、PITR、恢复/删除演练未完成 |
| 公开 H5 安全包装 | PASS | Worker-only 公网实测哈希 CSP、安全头、禁止嵌入、200/304/400/404/405、HEAD、压缩、noindex/robots 与 Worker 日志 |
| 历史供应链 | PASS（范围限定的历史证据） | 历史根 pnpm 图、部署锁和 Gradle 校验证据不作为当前审计结果。此前 CycloneDX 为无依赖边图的 773 个去重组件集合，773/773 具有哈希和声明许可证；OSV 对 722 个 npm 与 51 个 Maven PURL 的 0 个发现仅是当时查询结果，不表示今天原始警报为 0。当前扫描范围、原始警报和已验证补丁处置以本页上方规则及新报告为准。Gradle checksum pinning 不独立证明上游发布者身份；许可证字段未经法律审查 |
| Android 个人签名与本地来源清单 | PASS（个人侧载） | 维护者构建必须通过 `WUYAN_ANDROID_SIGNING_ROOT` 使用仓库外的固定三文件目录；真实路径、固定密钥库和版本化证书指纹任一不符均失败关闭。CURRENT manifest 记录当前源码 JAR 条目/签名数、自签名无 TSA 及 dirty 实际快照，验证器逐文件核对，不沿用历史版本数字。新发布使用工具级不覆盖的版本目录和 append-only CURRENT 指针日志，完整验证后才提交；协议为 crash-recoverable，不宣称 Windows 目录 crash-atomic 或文件系统 ACL 只读。构建/JVM 总门禁默认不运行设备，只有显式 `ANDROID_SERIAL` 的设备门禁精确确认 26/26 时才算设备阶段通过 |
| SLSA provenance | BLOCKED | 尚未由受控远端构建器生成并签名；本地 Android manifest 不等同于 SLSA provenance，不得自报 SLSA 等级 |
| 可恢复构建源码 | PASS（签名快照） | 当前 APK 随附同证书签名的精确源码归档，验证器逐文件检查路径、大小和 SHA-256；固定 Node/pnpm 与 Gradle 锁/校验元数据支持重建。尚未证明不同机器可逐字节复现 APK，也没有受控远端构建记录，故不称“可复现构建” |

## 正式联网服务 / 平台上线闸门

以下条件仍适用于对应的联网服务、小程序或平台发行范围；Android 个人侧载发布不等于这些生产条件已完成，不能据此把实验服务标记为“正式上线”：

- 主体、服务类目、正式 AppID、小程序/APP 备案、域名/ICP 备案、境内生产部署和平台审核。
- 具名医学/药学审核、热线和转介资源复核、法律/隐私文本、个人信息保护影响评估与合规审计机制。
- PostgreSQL 迁移、KMS 和密钥轮换、管理员 MFA/SSO、监控告警、死信处置、备份恢复、删除 SLA 与事故演练。
- 正式订阅模板、iOS/Android 微信真机、分享、弱网、升级、系统大字号和读屏人工验收。
- 商标/重名、软件著作权与开源许可证义务复核；任何疗效研究另行伦理审批、预注册与统计方案。

## 参考基线

- [OWASP ASVS 5.0](https://owasp.org/www-project-application-security-verification-standard/)：Web/API 设计与验证控制参考。
- [OWASP MASVS](https://mas.owasp.org/MASVS/)：移动客户端存储、网络、平台和韧性风险参考。
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)：自动化与人工无障碍验收基线。
- [SLSA v1.2 Build Track](https://slsa.dev/spec/v1.2/build-requirements)：远端构建来源与 provenance 的后续目标。
- [《中华人民共和国个人信息保护法》](https://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html)及届时有效配套规则：敏感个人信息、单独同意、最小必要、权利响应与影响评估边界。
