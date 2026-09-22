# Android 双代理审查与修复（2026-09-22）

## 审查范围

- 两个全新代理：`fresh_user_experience_audit`、`fresh_technical_audit`，均为 GPT-6 Astra / Ultra，不继承历史对话结论。
- 用户体验代理实际操作专用 `Wuyan_API_36 / emulator-5554`；技术代理审查当前源码并运行测试；主代理负责集成、额外原生审查和交付验证。
- 当前产品以个人离线 Android 版为主。未操作另一任务的 `emulator-5560`，未清空既有模拟器数据，未公开发布或修改 GitHub Release。
- 仓库原有未提交的 Harmony 工作及同时进行的 iOS 工作均保留。iOS 原生功能不属于本次 Android 验收结论。

## 已确认问题与处理

| 编号 | 优先级 | 问题 | 处理与回归 |
| --- | --- | --- | --- |
| A01 | P2 | 日终确认弹窗打开后新增、修改记录、换计划或跨午夜，仍可能提交过时总数 | 确认携带计划、北京时间日期、总数及逐支记录签名；提交前精确复核，过时则拒绝，不写入旧确认。模型与状态层测试覆盖同支数编辑等情况 |
| A02 | P2 | 当天重新开始计划，可把创建前的时间计为连续无烟 | 连续时长起点不早于新计划创建时间；原“20 小时”复现已由回归测试拦截 |
| A03 | P2 | 损坏备份的减量计划日期范围非法，但解析成功后首页生成计划会抛错 | 导入严格校验创建日期与戒烟日期关系；无效备份不得替换当前可用状态 |
| A04 | P2 | 主状态已删除记录，但队列尚未成功确认清理时，小组件会重新计入 | 原生小组件同时应用删除墓碑，过滤两类待处理队列；不删除原始队列证据 |
| A05 | P2 | 原生队列将数字/布尔计划 ID 转成字符串，和 JS 校验不一致 | 所有身份字段必须是真正字符串；异常队列拒绝继续写入且保留原值 |
| A06 | P2 | 小组件快捷记录只改时间，仍强制填原因和强度 | 既有空详情记录允许只修改时间；新填写详情必须成对，原有完整详情不可清空；保留 ID、原录入时间及复盘信息 |
| A07 | P3 | Android 设置页没有可回看的数据处理说明 | 数据卡片增加主动打开的“数据与隐私”，说明本机、导出副本、删除边界、通知和小组件显示；不增加首页常驻提示 |
| A08 | P3 | 横屏固定记烟按钮遮住日终确认区域 | 记烟操作移入独立右侧区域，左侧内容可滚动；E2E 验证两个按钮不重叠 |
| A09 | P3 | 大字体下时间指标会断成“分 / 钟” | 时间值不拆行，指标按内容宽度自动换列，不以缩小字号处理 |
| A10 | P3 | 新功能后启动资源略超原有预算 | 按需加载低频原生导出异常处理界面；保留原有 160 KiB 入口及 180 KiB 首页闭包预算，不提高门槛 |
| A11 | 依赖高危通告 | 实时审计发现 qs、fast-uri、js-yaml、svgo、adm-zip 已有新修复版本 | 按维护者通告升级同主版本补丁线，重新检查工作区生产/全量与腾讯部署锁；不等同于离线 APK 中存在可利用入口，具体审计结果见最终记录 |
| A12 | P2 | 只确认今日 0 支可能把此前漏答的多天标成“已确认无烟”小时；24 小时徽章也可能在未确认时点亮 | 确认时长只覆盖连续已确认日期窗口，遇未知日停止；24 小时徽章要求确认；新增 2 项回归 |

应用业务审查没有确认 P0/P1；依赖高危通告另列并优先修补。此处不是证明项目没有其他缺陷。

## 基线与验证记录

- 初始工作区：类型检查通过，415 项工作区测试、138 项发布脚本测试、43 项浏览器 E2E 通过。
- 修复后的模型及状态层新增 19 项正式用例，初始 3 个技术复现从失败变为通过。
- 原生新增 2 项 instrumentation：删除墓碑/残留队列、错误类型/原值保留；指定设备执行 `OK (40 tests)`，非自动挑选设备。
- 原生 JVM 测试 43 项通过；debug 构建及 Android Lint 通过（0 errors，11 条现有/资源类 warnings，不宣称零警告）。
- 并行 iOS 适配短暂引起测试替身缺少接口，协调补齐后，工作区 434 项测试与类型检查重新通过。
- 首轮修复 E2E：43 项功能通过，1 项体积预算失败；继续优化后再验证，不将失败轮次写成全部通过。
- 最终构建、哈希及复验结果见下方交付记录。

## 实际设备操作证据

首轮报告：`.toolchains/audit-20260922/ux/UX-AUDIT.md`，包含 40 张截图的用途与过渡画面排除说明。

已实际操作：App 新增、补记、编辑、撤销、系统文件导出、四个主页面及 SOS、小组件单次与连续点击、回 App 数量一致、持续计时、大字号 2.0、横屏弹层。小组件 1→2→5，App 内也为 5；未丢弃历史数据。

源码及自动测试不替代真机操作；没有把截图中的动画/白屏过渡或残留 UI XML 当成缺陷证据。

## 边界

- 安卓模拟器通过不等于小米 15 Pro / 澎湃 OS 3 真机认证，本轮没有连接该真机。
- 新手设置两条路径、导出/删除和离线等有自动测试覆盖；首轮人工检查没有清空旧数据重跑新手流程，也没有实际执行全量删除或备份恢复往返。
- 墓碑、并发、日期边界由自动化验证；没有等待真实午夜。系统休眠下非精确午夜更新仍可能延迟，不申请精确闹钟或唤醒权限。
- 未进行 TalkBack 完整人工验收、应用商店审核、医学审核、iOS 原生编译或全新第三方渗透测试。
- 安装包是 debug 测试通道，包名 `cn.wuyantongxing.personal.debug`，不会覆盖 GitHub 的 `cn.wuyantongxing.personal` 正式包；不得先卸载旧包来“更新”。

## 最终交付记录

本轮候选 APK（非 GitHub Release）：

- 文件：`artifacts/android-audit-20260922/wuyan-tongxing-audit-20260922-debug.apk`
- 大小：10,325,000 字节。
- SHA-256：`33cebfcaddcd17bef1091d3cfa629000f8f6e631cac40f652f6e950d91678137`。
- 包名 `cn.wuyantongxing.personal.debug`；版本名 `0.1.0-personal.32-debug`，versionCode 32。本轮没有宣称发布新正式版本。

最终自动验证（本次实跑）：

| 验证 | 结果 | 原始记录 |
| --- | --- | --- |
| 全工作区测试 | 440/440，其中 client 360；包含并发 iOS 任务增加的 4 个 JS 分支测试，不代表 iOS 原生验收 | `.toolchains/audit-workspace-final.log` |
| 类型检查 | 全工作区通过 | `.toolchains/audit-typecheck-final.log` |
| 发布脚本单元测试 | 138/138 | `.toolchains/audit-release-final.log` |
| 浏览器端到端 | 45/45，含快捷记录只改时间、跨午夜确认拒绝、横屏按钮不重叠 | `.toolchains/audit-e2e-final.log` |
| 原生 JVM / Lint / 构建 | JVM 43/43，debug 构建成功，Lint 0 errors / 11 warnings | `.toolchains/audit-android-package.log` |
| 最终 APK instrumentation | 40/40，安装以上哈希 APK 后指定 emulator-5554 执行 | `.toolchains/audit-native-instrumentation-final.log` |
| 依赖审计 | 根生产图、完整图、Tencent 锁文件均通过 low 阈值 0 已知漏洞门禁 | `.toolchains/audit-dependencies-final.log` |
| 入口体积 | 159.6 KiB / 160 KiB；首页完整闭包 176.6 KiB / 180 KiB | E2E performance 输出 |

修补的依赖线：qs 6.16.0、fast-uri 3.1.6 / 4.1.3、js-yaml 4.3.2、svgo 3.3.5、adm-zip 0.6.1。此前的“13/15 条”是审计通告/版本线计数，并非 13/15 个独立可利用的手机漏洞。维护者来源：[qs](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g)、[fast-uri](https://github.com/fastify/fast-uri/security/advisories/GHSA-5jgf-p345-68v8)、[js-yaml](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)、[svgo](https://github.com/svg/svgo/security/advisories/GHSA-w27v-7q3p-w38r)、[adm-zip](https://github.com/cthackers/adm-zip/security/advisories/GHSA-7q85-xj36-vmfc)。

本轮没有刷新公开 Release 的 SBOM/OSV/源码归档，也没有执行正式签名发布流程；将来公开发布前应根据最终候选重新生成对应证据。现在的交付是本地 debug 修复验证包。

最终人工复验已完成（17:29–17:35 北京时间）：用户体验代理独占 emulator-5554 实际点击复验，开始核对冻结 APK，结束核对设备已安装 base.apk，二者 SHA-256 均与上述交付一致。

- 快捷记录不填原因/强度即可只改时间，支数保持 6，小组件计时同步反映修改后的时间。
- 数据与隐私入口可打开、关闭；横屏确认与记录按钮不重叠，分别可点击；字体 2.0 下“分钟”完整显示，记录弹层可达。
- 实际执行“打开 5 支日终确认→回桌面小组件新增至 6→回旧弹窗确认”，正确拒绝过时提交，保持今日 6 支待确认。
- 未发现此次修复引入的回归或新增阻断项；这不代表穷尽所有使用场景。设置已恢复字体 1.0、竖屏及自动旋转，保留历史数据。

完整复验与 19 张截图：`.toolchains/audit-20260922/ux/retest/RETEST.md`。关键截图：`06-stale-result.png`、`09-quick-time-saved.png`、`14-landscape.png`、`17-font2.png`。
