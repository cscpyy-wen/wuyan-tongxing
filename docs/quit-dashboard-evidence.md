# 戒烟首页健康指标证据矩阵

核对日期：2026-10-13。适用范围：已停止吸卷烟用户的辅助记录与健康科普；不是个体风险计算器。以下均为简短改写，保留原来源的终点与时间范围。

## 健康时间线

| 模块标识 | 戒烟后参考时间 | 可表达的信息 | 比较对象或限制 | 来源及页面日期 |
| --- | --- | --- | --- | --- |
| `heart-rate` | 几分钟 | 心率开始下降 | 不代表已恢复正常；不设置分钟级达成阈值 | [CDC 戒烟益处][cdc-benefits]，2024-05-15 |
| `carbon-monoxide` | 数天 | 血液一氧化碳可降至不吸烟者水平 | 没有个人血液检测；不把“数天”虚构成固定天数 | [CDC 戒烟益处][cdc-benefits]，2024-05-15 |
| `breathing` | 1–12 个月 | 咳嗽、气短通常减轻 | 症状变化存在个体差异 | [CDC 戒烟益处][cdc-benefits]，2024-05-15 |
| `heart-attack` | 1–2 年 | 心肌梗死风险明显下降 | 戒烟相对继续吸烟；没有统一降幅 | [CDC 心血管疾病][cdc-cardiovascular]，2024-09-17 |
| `coronary-excess-risk` | 3–6 年 | 吸烟带来的额外冠心病风险约减半 | “额外风险”不是个人总风险 | [CDC 心血管疾病][cdc-cardiovascular]，2024-09-17 |
| `stroke-risk` | 5–10 年 | 卒中风险下降 | 戒烟相对继续吸烟；不声称已等同从不吸烟者 | [CDC 心血管疾病][cdc-cardiovascular]，2024-09-17 |
| `oral-pharyngeal-laryngeal-cancer` | 5–10 年 | 口腔、咽、喉癌的额外风险约减半 | 不能扩大为全部癌症 | [CDC 癌症][cdc-cancer]，2024-09-17 |
| `lung-cancer` | 10–15 年 | 吸烟带来的额外肺癌风险约减半 | 肺癌发生风险，不是死亡率或个人概率 | [CDC 癌症][cdc-cancer]，2024-09-17 |
| `coronary-long-term` | 15 年 | 冠心病风险接近不吸烟者 | “接近”不等于所有心血管疾病风险正常 | [CDC 心血管疾病][cdc-cardiovascular]，2024-09-17 |

长期风险下降以戒烟相对于继续吸烟为背景；“额外风险”指吸烟所增加的部分，不是总风险。CDC 的[临床癌症说明][cdc-cancer-care]进一步界定了这一概念（页面日期 2024-05-15）。页面日期不是原始研究发表日期，也不是本次核对日期；模块分别保存 `sourcePublishedAt` 与 `sourceCheckedAt`。

## 时间状态与产品边界

`healthMilestonePhase` 只定位经过时间：`ahead` 为尚未到参考起点，`within` 为位于含首尾的参考区间，`elapsed` 为超过区间末端（单时点为到达或超过），`general` 为无明确阈值或输入无效。它不读取系统时间、不存储健康信息、不计算评分。

范围定位采用一年 365.25 天、一个月 365.25 / 12 天的明确近似，不用于精确周年提醒或生理推断。“几分钟”“数天”始终是一般信息。UI 应显示“时间段参考，非个人测量”，状态文案只描述经过时间；不要把 `elapsed` 翻译为“恢复完成”“风险下降已达成”。

保留来源支持的“约减半”，不生成个人风险百分比，不在节点之间线性插值，不合成健康恢复分数。不同终点（心肌梗死、冠心病、心血管病整体、肺癌发生、肺癌死亡）不可互换。本模块统一使用上述 CDC 口径。

## 尼古丁、烟费与成就指标

| 指标 | 依据与展示规则 | 核对记录 |
| --- | --- | --- |
| 卷烟来源尼古丁粗估 | ACS 说明每支卷烟通常递送约 1–2 mg，实际摄入取决于吸入方式。预计少抽 N 支可用 N–2N mg 作为群体平均假设下的粗估，不能当作个人范围上下界或置信区间 | [ACS][acs-nicotine]，修订 2024-11-19；核对 2026-10-13 |
| NIDA 交叉依据 | 官方报告索引同样写平均每支摄入 1–2 mg；仅作补充，不用烟丝所含尼古丁代替吸收量 | [NIDA 报告第 6 页][nida-nicotine]；2026-10-13 检索索引可见，直连本次遇人机验证，未确认版本日期；当前产品引用以可完整核对的 ACS 为准 |
| 烟盒烟气烟碱量 | 机器测定烟气产量不能代表实际人体吸收，不应用包装数值制造个人精确摄入量 | [NCI 低焦油卷烟说明][nci-light]；核对 2026-10-13，未采用页面日期 |
| NRT 与其他尼古丁来源 | 贴片、口香糖等仍提供尼古丁；可计“少从卷烟摄入”，不可声称“总尼古丁减少”或“已清零”。NRT 不应中断未吸卷烟成就 | [NCI 戒断与替代治疗][nci-nrt]；核对 2026-10-13，未采用页面日期 |
| 无烟时长、少抽支数、烟费 | 根据用户提供的停止时间和戒烟前基线计算。省钱用“预计少花烟费”，未计替代治疗费用时不称净节省；连续时长与累计成果须区分 | 产品计算约定，不是临床测量或疗效证据 |

尼古丁卡片建议名称为“少从卷烟摄入的尼古丁（粗估）”，详情说明“按戒烟前日均支数估算；实际吸收因人而异；不计其他尼古丁来源”。不把减少的毫克数换算成癌症或心血管风险降幅，不默认设置“24 小时尼古丁归零”成就。

[cdc-benefits]: https://www.cdc.gov/tobacco/about/benefits-of-quitting.html
[cdc-cardiovascular]: https://www.cdc.gov/tobacco/about/cigarettes-and-cardiovascular-disease.html
[cdc-cancer]: https://www.cdc.gov/tobacco/about/cigarettes-and-cancer.html
[cdc-cancer-care]: https://www.cdc.gov/tobacco/hcp/patient-care-settings/cancer.html
[acs-nicotine]: https://www.cancer.org/cancer/risk-prevention/tobacco/guide-quitting-smoking/why-people-start-using-tobacco.html
[nida-nicotine]: https://nida.nih.gov/sites/default/files/1344-tobacco-nicotine-and-e-cigarettes_1.pdf
[nci-light]: https://www.cancer.gov/about-cancer/causes-prevention/risk/tobacco/light-cigarettes-fact-sheet
[nci-nrt]: https://www.cancer.gov/about-cancer/causes-prevention/risk/tobacco/withdrawal-fact-sheet
