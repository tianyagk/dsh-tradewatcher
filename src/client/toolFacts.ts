/**
 * 「方法与边界」两段散文的**事实清单**（v0.85.0 收口）。
 *
 * 背景：用户要求底部从「14 条项目符号」改成**两段散文**（`当前偏好怎么判断` / `这份数据的边界`）。
 * 排版变了、事实一条都不许少 —— 但"条数"已经不是判据（散文可以把两句话并成一句）。
 * 所以这里把**必须存在的事实主题**列出来（每条 = 主题 + 断言关键词），由
 * `missingFactTopics()` 在**两段并集**（+ 宿主 `FLOW_BOUNDARY`）上核对：
 *   · 少一条事实 ⇒ 对应主题的关键词找不到 ⇒ 断言红；
 *   · 关键词清单只读关键词，不锁句式 ⇒ 允许继续改文案，不允许删事实。
 *
 * ⚠ 关键词必须"人读得出来"、且能唯一指认那条事实；**不要**用单个字符（如 `%`）当关键词。
 */
export interface FactTopic {
  /** 主题号（与 `docs/DESIGN-TOOL-PAGE-ALIGN.md` §13.3.4 的编号一致） */
  id: string
  /** 主题（人读） */
  label: string
  /** 关键词：**全部**命中才算这条事实在（大小写敏感、逐字） */
  keywords: readonly string[]
  /**
   * 等价说法（任一组全部命中即可）——只在"同一事实有两种写法"时用。
   *
   * 目前只有 #9「不用 0 顶替」：宿主口径行写的是阿拉伯 `0`，工具文件的方法段用「不用零顶替」
   * （工具文件里不许出现阿拉伯数字，见零数字红线）⇒ 两种写法都算这条事实在。
   */
  alternatives?: readonly (readonly string[])[]
}

export const FACT_TOPICS: readonly FactTopic[] = [
  { id: '1', label: '风险偏好代理 ≠ 真实跨境资金净流入', keywords: ['风险偏好代理'] },
  { id: '2', label: '非资产规模 / 非跨境净流入', keywords: ['非资产规模', '跨境资金净流入'] },
  { id: '3', label: '偏好分口径（三项加权）', keywords: ['偏好分'] },
  { id: '4', label: '分位/动量无量纲 ⇒ 不吃汇率', keywords: ['无量纲'] },
  { id: '5', label: '规模只展示、不进权重', keywords: ['不参与权重'] },
  { id: '6', label: '五只宽基 ETF 代理口径', keywords: ['宽基 ETF'] },
  { id: '7', label: '汇率折算 / 折算不到就单列', keywords: ['折算'] },
  { id: '8', label: '未取到 + 原因', keywords: ['未取到'] },
  { id: '9', label: '不用 0 顶替', keywords: ['0'], alternatives: [['0'], ['不用零']] },
  { id: '10', label: '快照作废 + 留痕', keywords: ['快照'] },
  { id: '11', label: '实测日 / 重建日标注', keywords: ['重建'] },
  { id: '12', label: 'A股净流入单列', keywords: ['净流入'] },
  { id: '13', label: '不给买卖建议', keywords: ['买卖建议'] },
  { id: '14', label: '贪婪值 = 自身区间分位（窗口 60）', keywords: ['贪婪值'] },
  { id: '15', label: '分母只含有值市场', keywords: ['分母'] },
]

/** 一条事实的等价说法（`alternatives` 缺省 = `[keywords]`） */
export function keywordGroupsOf(topic: FactTopic): readonly (readonly string[])[] {
  return topic.alternatives ?? [topic.keywords]
}

/** 某一行文本是否承载这条事实（任一等价说法全命中即可） */
export function topicInLine(topic: FactTopic, line: string): boolean {
  return keywordGroupsOf(topic).some((group) => group.every((k) => line.includes(k)))
}

/** 并集文本里**缺**掉的事实主题（返回 [] 表示 15 条主题全在） */
export function missingFactTopics(unionText: string): string[] {
  return FACT_TOPICS.filter((t) => !keywordGroupsOf(t).some((group) => group.every((k) => unionText.includes(k)))).map((t) => t.id)
}

/** 判据（唯一实现）：给两段并集的文本，返回人读的问题清单 */
export function factCoverageProblems(unionText: string, subject = '方法 + 边界两段'): string[] {
  const missing = missingFactTopics(unionText)
  if (missing.length === 0) return []
  const labels = FACT_TOPICS.filter((t) => missing.includes(t.id)).map((t) => `#${t.id} ${t.label}`)
  return [`${subject}少了事实主题：${labels.join(' ／ ')}（散文可以改句式，但不许删事实）`]
}
