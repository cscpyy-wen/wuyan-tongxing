import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { toShanghaiDate, toShanghaiTime } from '../lib/smokingLogs'
import { AccessibleButton as Button } from './AccessibleButton'

export default function QuitCalculationDetails({ startedAt }: { startedAt: string }) {
  return <View className='quit-basis'>
    <Text>起点：{toShanghaiDate(startedAt)} {toShanghaiTime(startedAt)}（北京时间）。连续时间按完整 24 小时算一天；吸烟记录会重启连续计时，历史估算不清零。</Text>
    <Text>少吸支数 = 从设定起点起，经过天数 × 原日均支数（向下取整）− 已记录支数，最低为 0。少花烟费 = 少吸支数 × 包价 ÷ 每包支数；不扣除戒烟用品等开支。依赖自报与完整记录，不替代进展页的逐日确认。历史每日汇总可能只有近似时间。</Text>
    <Text>尼古丁按常见每支约 1–2 mg 吸收量作粗估，并非个人上下界或排出量。实际吸收因吸烟方式而异；不包括贴片、口香糖、电子烟等来源。尼古丁量不能换算成癌症风险。</Text>
    <Text>健康轨迹是群体规律，不是个人检测。高亮只表示进入参考时间段，不表示身体已达到该状态。月、年按 365.25 天作近似换算；不计算个人风险百分比。圆环只表示无烟天数纪念目标进度。</Text>
    <Text>CDC《Benefits of Quitting Smoking》，2024-05-15；ACS《Why People Start Smoking and Why It’s Hard to Stop》，2024-11-19。本次核对：2026-10-13。</Text>
    <Button className='quit-source-button' onClick={() => Taro.setClipboardData({ data: 'https://www.cdc.gov/tobacco/about/benefits-of-quitting.html' })}>复制 CDC 来源链接</Button>
    <Button className='quit-source-button' onClick={() => Taro.setClipboardData({ data: 'https://www.cancer.org/cancer/risk-prevention/tobacco/guide-quitting-smoking/why-people-start-using-tobacco.html' })}>复制尼古丁估算来源</Button>
  </View>
}
