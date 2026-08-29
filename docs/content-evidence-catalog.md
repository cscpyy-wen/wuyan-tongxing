# 戒烟内容证据目录

> 目录版本：0.1.0，资料元数据核对日期：2026-08-23。该目录支持内部内容设计，不替代医学、药学、法律或本地服务可用性审核。

唯一机器可读事实源为 `packages/content/src/data/evidence-sources.json`。每条记录同时保存适用范围与局限，内容通过 `evidenceIds` 引用。

| ID | 来源 | 年份 | 在本产品中的用途 | 关键边界 |
|---|---|---:|---|---|
| `WHO-TOBACCO-CESSATION-2024` | [WHO 成人烟草戒断临床治疗指南](https://www.ncbi.nlm.nih.gov/books/NBK604665/) | 2024 | 行为、数字与药物支持主干 | 个体用药仍需专业评估 |
| `WHO-5A5R-2014` | [WHO 5A/5R 工具包](https://www.who.int/publications/i/item/toolkit-for-delivering-5as-and-5rs-brief-tobacco-interventions-in-primary-care) | 2014 | 动机、协助和随访结构 | 产品不模拟临床诊疗 |
| `BCT-TAXONOMY-V1-2013` | [BCT Taxonomy v1](https://pmc.ncbi.nlm.nih.gov/articles/PMC3609782/) | 2013 | 统一描述行为改变组件 | 分类不是疗效证据 |
| `COMB-BCW-2011` | [COM-B 与 Behaviour Change Wheel](https://implementationscience.biomedcentral.com/articles/10.1186/1748-5908-6-42) | 2011 | 能力、机会、动机分析 | 框架不是产品临床验证 |
| `NCI-QUITSTART` | [NCI quitSTART](https://smokefree.gov/tools-tips/quitstart) | 2025 | 诱因、SOS、滑倒恢复产品模式 | 官方工具说明不等于组件独立疗效 |
| `NCI-WITHDRAWAL` | [NCI 戒断管理](https://smokefree.gov/challenges-when-quitting/withdrawal/managing-nicotine-withdrawal) | 2025 | 常见戒断体验和低风险应对 | 不能据此诊断症状原因 |
| `NCI-LAPSE-RECOVERY` | [NCI 滑倒后恢复](https://smokefree.gov/challenges-when-quitting/stick-with-it/get-back-on-track) | 2025 | 非惩罚性复盘与重启 | 不称为独立复吸预防治疗 |
| `COCHRANE-MOBILE-2019` | [Cochrane 手机戒烟干预综述](https://www.cochrane.org/evidence/CD006611_can-programmes-delivered-mobile-phones-help-people-stop-smoking) | 2019 | 数字工具的证据边界 | 应用证据异质，不能保证成功 |
| `COCHRANE-NRT-2023` | [Cochrane NRT 使用方式综述](https://www.cochrane.org/evidence/CD013308_what-best-way-use-nicotine-replacement-therapy-quit-smoking) | 2023 | NRT 和联合 NRT 通用科普 | 不提供个体剂量或组合建议 |
| `COCHRANE-PARTIAL-AGONISTS-2023` | [Cochrane 伐尼克兰与金雀花碱综述](https://www.cochrane.org/evidence/CD006103_can-medications-varenicline-and-cytisine-nicotine-receptor-partial-agonists-help-people-stop-smoking) | 2023 | 其他戒烟药物概览 | 中国批准和可及性需另行核验 |
| `COCHRANE-INDIVIDUAL-COUNSELLING-2017` | [Cochrane 个体行为咨询综述](https://www.cochrane.org/evidence/CD001292_does-individually-delivered-counselling-help-people-stop-smoking) | 2017 | 专业支持转介理由 | 数字自助不等同专业咨询 |
| `ICANQUIT-ACT-RCT-2020` | [iCanQuit ACT 随机试验](https://jamanetwork.com/journals/jamainternalmedicine/fullarticle/2770816) | 2020 | 接纳、认知解离、烟瘾冲浪 | 单项研究和海外语境需本地验证 |
| `IMPLEMENTATION-INTENTIONS-2020` | [实施意图系统评价](https://pubmed.ncbi.nlm.nih.gov/33220048/) | 2020 | “如果—那么”计划 | 平均效果小，不能保证结果 |
| `SMARTT-JITAI-RCT-2025` | [Smart-T JITAI 随机试验](https://jamanetwork.com/journals/jamanetworkopen/fullarticle/2837640) | 2025 | 及时、适应性支持设计 | 首版只用透明规则，不复制算法 |
| `CHINA-HAPPY-QUIT-RCT-2019` | [中国 Happy Quit 短信随机试验](https://www.sciencedirect.com/science/article/pii/S0140673618326357) | 2019 | 本地化持续触达 | 不能外推为任意小程序功能疗效 |
| `CHINA-PERSONALIZED-SMS-RCT-2023` | [中国个性化短信随机试验](https://jamanetwork.com/journals/jamanetworkopen/fullarticle/2801838) | 2023 | 透明个性化提示 | 不等同生成式 AI 或医疗判断 |
| `CHINA-WAY-TO-QUIT-RCT-2026` | [中国微信组合干预随机试验](https://pmc.ncbi.nlm.nih.gov/articles/PMC13130533/) | 2026 | 小程序、本地支持和长期留存 | 组合效果不可归因于单一组件 |
| `CHINA-CDC-QUIT-PLATFORM-2022` | [中国戒烟平台](https://www.chinacdc.cn/jkyj/yckz/gzdt/202203/t20220310_296389.html) | 2022 | 国内热线、门诊和资源转介 | 正式发布前逐项复核可用性 |
| `CHINA-NHC-SMOKING-REPORT-2020` | [中国吸烟危害健康报告 2020](https://www.nhc.gov.cn/guihuaxxs/c100133/202105/60eefbe50e3b4426b2e83ae8d2f62835.shtml) | 2021 | 吸烟、二手烟和电子烟风险科普 | 不预测个体风险或恢复时间 |
| `CHINA-NHC-12356-2025` | [国家卫健委 12356 通知](https://www.nhc.gov.cn/yzygj/c100068/202412/49a1a65386cd4be582d4702fd0926ee8.shtml) | 2025 | 心理援助人工入口 | 紧急人身危险仍联系 110/120 |
| `CHINA-PIPL-2021` | [个人信息保护法](https://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html) | 2021 | 敏感信息和单独同意边界 | 上线前仍需结合配套规则法审 |
| `CHINA-INTERNET-DIAGNOSIS-2022` | [互联网诊疗监管细则（试行）](https://www.nhc.gov.cn/yzygj/c100068/202203/2072f0e8988249e59d942e1b2a933916.shtml) | 2022 | 不诊断、不开处方的产品边界 | 健康教育定位不代表诊疗资质 |

## 使用规则

1. 内容只能引用目录内稳定 ID；校验脚本拒绝悬空引用。
2. 药物、急症、心理援助、健康时间线和转介资源在每次公开发布前必须复核原始来源。
3. 证据支持的是受限主张，不是对本产品疗效、监管认证或个体结果的背书。
4. 来源更新或失效时新增证据版本并完成影响审查，不静默覆盖既有发布记录。
