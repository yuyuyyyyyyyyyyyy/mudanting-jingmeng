/**
 * B 版 Agent —— 单次核心介入
 *
 * 只读取三样证据：
 *   1. 学生体验前亲自写下的初始理解（initialUnderstanding）
 *   2. 学生明确选择的"变化起点"原文（active pin 的 text）
 *   3. 学生是否主动移动过针脚（pins 中 active=false 的旧条数 > 0）
 *
 * 不读取：停留时间、滚动速度、点击犹豫等隐性行为。
 * 不生成：新原文、性格判断、心理诊断。
 *
 * 输出结构化：{ readingPath, responseId, relation, reason }
 *   - responseId 必须来自人工审核候选库
 *   - 失败/非法 → 本地确定性规则选候选
 *   - 本地也无可靠候选 → 只显示"这本书记住了你的选择"，不强行建立关系
 */
import type { BPersisted, BAgentResponse } from './store'

/** Agent 思考过程的可见阶段 —— 让读者看到 AI 在"接收目标→制定计划→用工具→检查→修正→完成" */
export type AgentStageId =
  | 'receive'    // 接收目标：读取读者选择
  | 'plan'       // 制定计划：本地推导阅读偏向
  | 'tool'       // 使用工具：调用 DeepSeek
  | 'check'      // 检查结果：校验 AI 返回的候选 id 是否合法
  | 'revise'     // 修正并继续：校验失败则本地兜底
  | 'done'       // 完成任务：选定回应

export interface AgentStageEvent {
  id: AgentStageId
  label: string
  detail: string
  at: number
}

export type StageEmitter = (stage: AgentStageEvent) => void

export interface BResponseCandidate {
  id: string
  readingPath: string
  relation: string
  chapterId: string
  sectionId: string
  tune: string | null
  sourceText: string
  where: string
  hint: string
  reason: string
  reviewed: true
}

export interface BResponseTable {
  version: string
  readingPaths: string[]
  candidates: BResponseCandidate[]
}

/** 把学生选中的原文句 → 阅读理解类别（确定性词表，可独立测试） */
export function inferReadingPath(pinText: string, initialUnderstanding: string): string {
  const t = (pinText || '') + ' ' + (initialUnderstanding || '')
  const has = (words: string[]) => words.some(w => t.includes(w))

  // 写景惜春：聚焦春色、花、园景、断井颓垣
  if (has(['姹紫嫣红', '断井颓垣', '良辰美景', '赏心乐事', '春色', '春天', '写景', '惜春', '雨丝风片', '烟波画船', '云霞翠轩', '朝飞暮卷', '荼蘼', '杜鹃', '燕语', '莺歌', '游园'])) {
    return '写景惜春'
  }
  // 自伤身世：颜色、命、幽闺、韶光贱
  if (has(['锦屏人', '韶光贱', '颜色如花', '命如一叶', '幽闺自怜', '如花美眷', '似水流年', '颜色', '命', '妾身'])) {
    return '自伤身世'
  }
  // 春情初动：春情、怀人、幽怨、春心
  if (has(['春情', '怀人', '幽怨', '睡情', '春心', '淹煎', '泼残生', '因循腼腆', '幽梦'])) {
    return '春情初动'
  }
  // 梦醒失落：南柯一梦、如有所失、行坐不宁、冷汗
  if (has(['南柯一梦', '如有所失', '行坐不宁', '冷汗', '心悠步亸', '那梦儿还去不远', '困春心', '惊醒', '秀才，你去了'])) {
    return '梦醒失落'
  }
  return '其他或不确定'
}

/** 本地兜底：根据 readingPath 在审核候选中选一条 */
export function localSelectCandidate(
  table: BResponseTable,
  readingPath: string,
): BResponseCandidate | null {
  // 1. 严格匹配 readingPath
  const exact = table.candidates.find(c => c.readingPath === readingPath)
  if (exact) return exact
  // 2. 兜底 neutral
  const neutral = table.candidates.find(c => c.readingPath === '其他或不确定')
  return neutral || null
}

/** 校验 AI 返回的 responseId 是否在审核候选库中 */
export function validateCandidate(
  table: BResponseTable,
  responseId: string,
): BResponseCandidate | null {
  if (!responseId) return null
  return table.candidates.find(c => c.id === responseId && c.reviewed) || null
}

/**
 * 调用 /api/b-plan，失败/非法 → 本地兜底。
 * 如果本地兜底也找不到可靠候选 → 返回 null（前端只显示"这本书记住了你的选择"）。
 */
export async function requestBResponse(
  table: BResponseTable,
  state: BPersisted,
  onStage?: StageEmitter,
): Promise<BAgentResponse | null> {
  const emit = onStage || (() => {})
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

  const activePin = state.pins.find(p => p.active) || state.pins[state.pins.length - 1] || null
  const pinText = activePin?.text || ''
  const initial = state.initialUnderstanding || ''
  const movedPin = state.pins.filter(p => !p.active).length > 0

  // 1) 接收目标：读取读者的针脚与初始理解
  emit({ id: 'receive', label: '接收目标', detail: '读取你选定的原文与初始理解', at: Date.now() })
  await wait(380)

  // 2) 制定计划：本地先推导阅读偏向（无论 AI 是否在线都用作校验）
  const localPath = inferReadingPath(pinText, initial)
  emit({ id: 'plan', label: '制定计划', detail: `推导阅读偏向：${localPath}`, at: Date.now() })
  await wait(420)

  // 3) 使用工具：调用 DeepSeek
  emit({ id: 'tool', label: '使用工具', detail: '请求 AI 在审核候选中排序', at: Date.now() })
  try {
    const reviewedCandidates = table.candidates.map(c => ({
      id: c.id,
      readingPath: c.readingPath,
      relation: c.relation,
      sourceText: c.sourceText,
      hint: c.hint,
      reason: c.reason,
    }))
    const resp = await fetch('/api/b-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initialUnderstanding: initial.slice(0, 400),
        pinText: pinText.slice(0, 120),
        movedPin,
        localPath,
        reviewedCandidates,
      }),
    })
    if (resp.ok) {
      const data = await resp.json()
      if (data && data.ok && data.source === 'deepseek') {
        // 4) 检查结果：校验 AI 返回的候选 id 是否在人工审核库中
        emit({ id: 'check', label: '检查结果', detail: '校验 AI 返回的候选是否合法', at: Date.now() })
        await wait(360)
        const candidate = validateCandidate(table, String(data.responseId || ''))
        if (candidate) {
          emit({ id: 'done', label: '完成任务', detail: `AI 选定：${candidate.readingPath}`, at: Date.now() })
          return {
            responseId: candidate.id,
            readingPath: data.readingPath || candidate.readingPath,
            relation: data.relation || candidate.relation,
            reason: String(data.reason || candidate.reason).slice(0, 80),
            source: 'deepseek',
            candidateSnapshot: {
              sourceText: candidate.sourceText,
              where: candidate.where,
              hint: candidate.hint,
            },
            requestedAt: Date.now(),
          }
        }
        // 5) 修正并继续：AI 返回非法 → 本地兜底
        emit({ id: 'revise', label: '修正并继续', detail: 'AI 返回非法，回退到本地规则', at: Date.now() })
        await wait(360)
      }
    }
  } catch {
    emit({ id: 'revise', label: '修正并继续', detail: 'AI 不可达，回退到本地规则', at: Date.now() })
    await wait(360)
  }

  // 6) 完成任务：本地兜底选定
  const candidate = localSelectCandidate(table, localPath)
  if (!candidate) {
    emit({ id: 'done', label: '完成任务', detail: '未找到可靠候选', at: Date.now() })
    return null
  }
  emit({ id: 'done', label: '完成任务', detail: `本地选定：${candidate.readingPath}`, at: Date.now() })
  return {
    responseId: candidate.id,
    readingPath: candidate.readingPath,
    relation: candidate.relation,
    reason: candidate.reason,
    source: 'local',
    candidateSnapshot: {
      sourceText: candidate.sourceText,
      where: candidate.where,
      hint: candidate.hint,
    },
    requestedAt: Date.now(),
  }
}
