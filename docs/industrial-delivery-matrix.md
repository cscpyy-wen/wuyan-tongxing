# 工业交付验收矩阵

状态只使用三类：`PASS` 表示本轮有可复现证据；`SIMULATED` 表示契约/本机路径通过但真实平台未接入；`BLOCKED` 表示外部或生产条件未完成。本文不宣称获得 OWASP、WCAG、SLSA、医疗或法律认证。

## 工程候选版

| 领域 | 状态 | 阻断证据/验收证据 |
| --- | --- | --- |
| 免登录本地核心旅程 | PASS | 两条路径、记录、进展、SOS、滑倒、随访、导出/删除的单元与 H5 E2E |
| 离线与降级 | PASS | 成功初始化后断网重载和首次进入 SOS；提醒拒绝/失败降级 |
| 内容完整性 | PASS | 73 条内容、22 个证据来源、18 条主张映射；草案状态强制 |
| 医学正确性签署 | BLOCKED | 尚无具名医学/药学审核人、日期和签名 |
| 无障碍自动化 | PASS | axe 覆盖 WCAG 2.0/2.1/2.2 A/AA、键盘、触控区、溢出与对比度回归 |
| 真机无障碍/大字号/低性能 | BLOCKED | VoiceOver/TalkBack、系统大字号和低端真机人工证据未完成 |
| API 鉴权、输入、幂等与加密 | PASS | 严格 schema、重放冲突、用途隔离 AEAD、越权/限流/篡改回归 |
| 真实微信身份/订阅/分享 | SIMULATED | `touristappid` 与官方 IDE 测试号；正式 AppID、模板和真机未完成 |
| 可选云同步与统计 | SIMULATED | 服务端契约与隔离测试通过；客户端不接 API，开关只保存本地模拟状态 |
| 生产数据库/KMS/备份 | BLOCKED | PGlite 仅限本机；生产 API/Worker 当前无条件失败关闭，PostgreSQL、KMS、PITR、恢复/删除演练未完成 |
| 公开 H5 安全包装 | PASS | Worker-only 公网实测哈希 CSP、安全头、禁止嵌入、200/304/400/404/405、HEAD、压缩、noindex/robots 与 Worker 日志 |
| 供应链 | PASS（范围限定的工程证据） | 根 pnpm 生产/完整图和两个部署 npm 锁均以 low 阈值失败关闭；Gradle 运行时/构建脚本锁定、8.14.3 distribution 与 wrapper JAR 固定校验和、严格依赖校验、安装脚本白名单、固定 CI action。CycloneDX 是无依赖边图的 773 个去重组件集合，773/773 具有哈希和声明许可证；OSV 对 722 个 npm 与 51 个 Maven PURL 的 0 个发现仅是查询时点结果。Gradle metadata 为 checksum pinning 且 `verify-signatures=false`，未独立证明上游发布者身份；许可证字段未经法律审查 |
| Android 个人签名与本地来源清单 | PASS（个人侧载） | 维护者构建必须通过 `WUYAN_ANDROID_SIGNING_ROOT` 使用仓库外的固定三文件目录；真实路径、固定密钥库和版本化证书指纹任一不符均失败关闭。CURRENT manifest 记录当前源码 JAR 条目/签名数、自签名无 TSA 及 dirty 实际快照，验证器逐文件核对，不沿用历史版本数字。新发布使用工具级不覆盖的版本目录和 append-only CURRENT 指针日志，完整验证后才提交；协议为 crash-recoverable，不宣称 Windows 目录 crash-atomic 或文件系统 ACL 只读。构建/JVM 总门禁默认不运行设备，只有显式 `ANDROID_SERIAL` 的设备门禁精确确认 26/26 时才算设备阶段通过 |
| SLSA provenance | BLOCKED | 尚未由受控远端构建器生成并签名；本地 Android manifest 不等同于 SLSA provenance，不得自报 SLSA 等级 |
| 可恢复构建源码 | PASS（签名快照） | 当前 APK 随附同证书签名的精确源码归档，验证器逐文件检查路径、大小和 SHA-256；固定 Node/pnpm 与 Gradle 锁/校验元数据支持重建。尚未证明不同机器可逐字节复现 APK，也没有受控远端构建记录，故不称“可复现构建” |

## 正式大陆上线闸门

以下任一未完成都不得把本候选版标记为“正式上线”：

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
