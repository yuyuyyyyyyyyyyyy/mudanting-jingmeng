import type { Chapter, Echo, Section, Underline } from './types'

/**
 * AI 回应引擎 —— DeepSeek 语义排序，失败时由本地规则兜底。
 *
 * 四个函数与正式产品的 AI 接口一一对应：
 *   interpretUnderline()     理解划线对应的情绪、人物、意象
 *   findReviewedEchoes()     在已审核的原文关系表中检索回应
 *   checkSpoilerBoundary()   剧透边界检查：回应不得在读者到达之前泄露
 *   selectResponseTiming()   控制回应出现的时机与方式
 *
 * interpretUnderline 优先调用本机服务端的 DeepSeek 语义接口
 * （如 POST /api/interpret），其余三步仍须先经人工审核的关系表过滤，
 * 模型只做匹配排序，不生成新的「原文关系」。断网时本地规则兜底，
 * 核心阅读体验不依赖任何接口。
 */

// —— 文本工具 ——

/** 归一化：去标点与空白，只留可比对的字符 */
function normalize(s: string): string {
  return s.replace(/[，。！？；：、「」『』《》〈〉（）()\s——…·　-]/g, '')
}

/** 最长公共子串长度（对短句足够快） */
function lcsLength(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m || !n) return 0
  let prev = new Array(n + 1).fill(0)
  let best = 0
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0)
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

function sectionText(s: Section): string {
  return s.segments.map(x => x.text).join('')
}

// —— 第一步：理解划线 ——

export interface Interpretation {
  keywords: string[]        // 从划线文本提取的意象/人物线索（本地：命中词表）
  matchedEchoes: Echo[]     // 候选已审核关系
  confidence: number        // 0-1
  source: 'deepseek' | 'local'
  model?: string
}

const MOTIF_LEXICON: Record<string, string[]> = {
  spring: ['春', '花', '园', '莺', '燕', '杜鹃', '荼蘼', '韶光'],
  time: ['年', '流年', '春归', '光阴', '去年'],
  self: ['妾身', '俺', '奴家', '全身', '颜色', '命'],
  other: ['人', '谁家', '老爷', '奶奶', '母亲', '秀才'],
  dream: ['梦', '眠', '醒'],
  ruin: ['断井', '颓垣', '残', '冷'],
}

export async function interpretUnderline(
  selectionText: string,
  sectionId: string,
  chapter: Chapter,
): Promise<Interpretation> {
  const norm = normalize(selectionText)
  const keywords: string[] = []
  for (const [motif, words] of Object.entries(MOTIF_LEXICON)) {
    if (words.some(w => norm.includes(w))) keywords.push(motif)
  }

  // 与每条已审核关系的 source 做相似度比对
  const scored = chapter.echoes
    .filter(e => e.reviewed)
    .map(e => {
      const src = normalize(e.sourceText)
      let score = 0
      if (norm && src) {
        if (norm.includes(src) || src.includes(norm)) {
          score = 0.95
        } else {
          const lcs = lcsLength(norm, src)
          score = Math.max(lcs / src.length, lcs / Math.max(norm.length, 1))
        }
      }
      // 同段落的相邻句子给较弱的分
      if (e.sourceSectionId === sectionId) score = Math.max(score, 0.45)
      return { echo: e, score }
    })
    .filter(x => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)

  const localResult: Interpretation = {
    keywords,
    matchedEchoes: scored.map(x => x.echo),
    confidence: scored.length ? scored[0].score : 0,
    source: 'local',
  }

  try {
    const reviewed = chapter.echoes.filter(e => e.reviewed)
    const response = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectionText,
        sectionId,
        readingHistory: [sectionId],
        candidates: reviewed.map(e => ({
          id: e.id,
          sourceText: e.sourceText,
          targetText: e.targetText,
          relation: e.relation,
          explanation: e.explanation,
        })),
      }),
    })
    if (!response.ok) return localResult
    const semantic = await response.json()
    if (!semantic?.ok || semantic.source !== 'deepseek') return localResult
    const ids = Array.isArray(semantic.candidateEchoIds) ? semantic.candidateEchoIds : []
    const matchedEchoes = ids
      .map((id: string) => reviewed.find(e => e.id === id))
      .filter((echo: Echo | undefined): echo is Echo => !!echo)
    return {
      keywords: Array.isArray(semantic.motifs) ? semantic.motifs : keywords,
      matchedEchoes,
      confidence: Number.isFinite(semantic.confidence) ? semantic.confidence : 0,
      source: 'deepseek',
      model: typeof semantic.model === 'string' ? semantic.model : undefined,
    }
  } catch {
    return localResult
  }
}

// —— 第二步：检索已审核回应 ——

export async function findReviewedEchoes(
  interpretation: Interpretation,
  _chapter: Chapter,
): Promise<Echo[]> {
  // 只返回人工确认过的关系；找不到可靠关系时返回空，绝不为制造效果虚构
  return interpretation.matchedEchoes.filter(e => e.reviewed)
}

// —— 第三步：剧透边界检查 ——

export async function checkSpoilerBoundary(
  echo: Echo,
  currentSectionId: string,
  chapter: Chapter,
): Promise<boolean> {
  const order = chapter.sections.map(s => s.id)
  const earliest = order.indexOf(echo.earliestAt)
  const current = order.indexOf(currentSectionId)
  // 读者尚未读到回应出现的最早位置时，不提示
  return current >= earliest && earliest >= 0
}

// —— 第四步：选择回应时机 ——

export interface TimingPlan {
  echoId: string
  /** 'margin' = 页边重现旧下划线并等待读者点击；'silent' = 只记录不打扰 */
  mode: 'margin' | 'silent'
}

export async function selectResponseTiming(
  echoes: Echo[],
  revealedSectionId: string,
  chapter: Chapter,
  alreadyShown: string[],
): Promise<TimingPlan[]> {
  const plans: TimingPlan[] = []
  for (const echo of echoes) {
    if (alreadyShown.includes(echo.id)) continue
    const targetHit = echo.targetSectionId === revealedSectionId
    const boundary = await checkSpoilerBoundary(echo, revealedSectionId, chapter)
    plans.push({ echoId: echo.id, mode: targetHit && boundary ? 'margin' : 'silent' })
  }
  return plans
}

/** 合页用：为一条没有匹配到关系的划线，在已读范围内找一句位置最靠近的后文（不虚构关系，仅按段落序） */
export function nearestLaterSection(underline: Underline, chapter: Chapter): Section | null {
  const order = chapter.sections
  const idx = order.findIndex(s => s.id === underline.sectionId)
  if (idx < 0 || idx >= order.length - 1) return null
  return order[idx + 1]
}

/** 合页用：为最终选择的「开始」找一条已审核回应（同步本地规则）。 */
export function findEchoForText(text: string, chapter: Chapter): Echo | undefined {
  let best: { echo: Echo; score: number } | undefined
  const norm = normalize(text)
  for (const echo of chapter.echoes) {
    if (!echo.reviewed) continue
    const src = normalize(echo.sourceText)
    const lcs = lcsLength(norm, src)
    const score = Math.max(lcs / src.length, lcs / Math.max(norm.length, 1))
    if (score >= 0.5 && (!best || score > best.score)) best = { echo, score }
  }
  return best?.echo
}

export { sectionText, normalize }
