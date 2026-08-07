import { useMemo, useState } from 'react'
import type { Chapter, AttentionMotif } from '../types'
import type { Persisted } from '../store'

// 选项 → 杜丽娘旅程节点的映射
const JOURNEY_MAP: Record<string, {
  readerLabel: string
  liniangStep: string
  originalLine: string
  motif: AttentionMotif
}> = {
  hear_birds: {
    readerLabel: '莺声',
    liniangStep: '在闺阁里，她被一声莺啼惊起。',
    originalLine: '莺声渐老，残英满地。',
    motif: 'sound',
  },
  see_her: {
    readerLabel: '庭院中的她',
    liniangStep: '她望向庭院，看见了自己的影子。',
    originalLine: '原来姹紫嫣红开遍，似这般都付与断井颓垣。',
    motif: 'self',
  },
  open_gate: {
    readerLabel: '园门',
    liniangStep: '她跨过园门，第一次走进那个花园。',
    originalLine: '不到园林，怎知春色如许？',
    motif: 'threshold',
  },
  mirror_self: {
    readerLabel: '镜中自己',
    liniangStep: '她在镜前停下，看见了自己如花的容颜。',
    originalLine: '你侧垂翠脾，立在太湖石边，端详可正是无双。',
    motif: 'self',
  },
  follow_bloom: {
    readerLabel: '盛开的花',
    liniangStep: '她站在花下，看见了满园的姹紫嫣红。',
    originalLine: '姹紫嫣红开遍，似这般都付与断井颓垣。',
    motif: 'spring',
  },
  trace_ruin: {
    readerLabel: '廊上的旧迹',
    liniangStep: '她回望游廊，看见了繁华之下的断井颓垣。',
    originalLine: '良辰美景奈何天，赏心乐事谁家院！',
    motif: 'ruin',
  },
}

interface Props {
  chapter: Chapter
  state: Persisted
  update: (fn: (s: Persisted) => Persisted) => void
  onNextChapter: () => void
  onOpenAbout: () => void
  onReopen: () => void
}

/**
 * 合页：像合上一本书
 * 题词 → 旅程 → 收束
 */
export default function Closing({ chapter, state, update, onNextChapter, onOpenAbout, onReopen }: Props) {
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')

  const journey = useMemo(() => {
    const seen = new Set<string>()
    const steps: typeof JOURNEY_MAP[string][] = []
    const labels: string[] = []
    for (const c of state.attention?.recentChoices || []) {
      const m = JOURNEY_MAP[c.optionId]
      if (!m || seen.has(c.optionId)) continue
      seen.add(c.optionId)
      steps.push(m)
      labels.push(m.readerLabel)
    }
    return { steps, labels }
  }, [state.attention])

  const interpretation = useMemo(() => {
    const weights = state.attention?.weights || {} as Record<AttentionMotif, number>
    const entries = (Object.entries(weights) as [AttentionMotif, number][])
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
    if (!entries.length) {
      return '你安静地走完了这场戏。戏台也记得这份安静。'
    }
    const [topMotif, topWeight] = entries[0]
    const total = entries.reduce((s, [, w]) => s + w, 0)
    const ratio = topWeight / total

    if (ratio >= 0.5) {
      switch (topMotif) {
        case 'spring':
          return '你最先看见的，是满园春色——和杜丽娘一样，你被「姹紫嫣红」留住了目光。'
        case 'ruin':
          return '你比杜丽娘更早看见了繁华之下的断井颓垣。她后来才懂的那句，你已经在意了。'
        case 'self':
          return '你一直在看她本人。她的眉眼、她在镜前的片刻，比春色更让你停下。'
        case 'sound':
          return '你一路在听。莺声、琴声、门声——杜丽娘的梦，是从声音里开始的。'
        case 'threshold':
          return '你关注的是那一步——从闺阁到花园的那一步。门槛两边，是两个世界。'
        default:
          return '你的目光走了一条自己的路，而它恰好通向杜丽娘。'
      }
    }
    return '你的目光在几个地方都停过——和杜丽娘一样，你也在春色与自己之间来回。'
  }, [state.attention])

  const saveAnnotation = () => {
    const text = draft.trim()
    if (!text) return
    update(s => ({
      ...s,
      annotations: [...s.annotations, { id: `a${Date.now().toString(36)}`, text, createdAt: Date.now() }],
    }))
    setDraft('')
    setWriting(false)
  }

  const hasJourney = journey.steps.length > 0
  const activeStart = state.starts.find(s => s.active)
  const [reconsidering, setReconsidering] = useState(false)
  const focalSection = chapter.sections.find(s => s.id === '10-07')
  const focalCandidates = (focalSection?.segments || []).slice(0, 4).map(segment => ({ sectionId: focalSection?.id || "10-07", text: segment.text }))
  const chooseNewStart = (candidate: { sectionId: string; text: string }) => {
    update(current => ({ ...current, starts: [...current.starts.map(s => ({ ...s, active: false })), { id: `start-revised-${Date.now().toString(36)}`, sectionId: candidate.sectionId, text: candidate.text, createdAt: Date.now(), active: true }] }))
    setReconsidering(false)
  }

  return (
    <div className="closing">
      {hasJourney ? (
        <>
          {/* 题词：像一本书的扉页 */}
          <header className="closing-epigraph">
            <span className="closing-seal" aria-hidden="true">记</span>
            <span className="closing-epigraph-mark">戏　台　闭　幕</span>
            <h1 className="closing-epigraph-title">
              <span className="ti-rouge">你留下的原文</span>，<br />
              和<span className="ti-rouge">杜丽娘后来走到的地方</span>，<br />
              在这里相遇。
            </h1>
            {journey.labels.length > 1 && (
              <div className="closing-epigraph-path">
                <span className="path-mark">你 一 路 留 意 的 是</span>
                <p className="path-text">{journey.labels.join('  →  ')}</p>
              </div>
            )}
          </header>

          {/* 重新判断 + 你放在「开始」的那一句 */}
          {activeStart && (
            <>
              <div className="closing-reconsider">
                <button type="button" className="text-entry-small" onClick={() => setReconsidering(v => !v)}>
                  {reconsidering ? '收起重新判断' : '读完以后，重新判断'}
                </button>
                {reconsidering && (
                  <div className="reconsider-options">
                    <span className="anno-meta">哪一句现在更像真正的开始？</span>
                    {focalCandidates.map(candidate => (
                      <button type="button" className="text-entry-small" key={candidate.text} onClick={() => chooseNewStart(candidate)}>{candidate.text}</button>
                    ))}
                  </div>
                )}
              </div>
              <div className="closing-start">
                <span className="jr-mark">你把变化的开始放在</span>
                <p className="jl-original">「{activeStart.text}」</p>
                <span className="anno-meta">读完以后，你仍然可以回到这里重新判断。</span>
              </div>
            </>
          )}

          {/* 戏台记得：解读 */}
          <div className="closing-interpretation">
            <span className="interp-mark">戏 台 记 得</span>
            <p className="interp-text">{interpretation}</p>
          </div>

          {/* 旅程：读者 → 杜丽娘 */}
          <div className="closing-journey">
            {journey.steps.map((step, i) => (
              <article className="journey-step" key={i}>
                <div className="journey-reader">
                  <span className="jr-mark">你 留 意 了</span>
                  <span className="jr-label">{step.readerLabel}</span>
                </div>
                <div className="journey-arrow" aria-hidden="true" />
                <div className="journey-liniang">
                  <span className="jl-mark">杜　丽　娘</span>
                  <p className="jl-step">{step.liniangStep}</p>
                  <p className="jl-original">{step.originalLine}</p>
                </div>
              </article>
            ))}
          </div>

          {/* 收束 */}
          <div className="closing-final">
            <p>同一出戏，同一条路。{'\n'}区别只在于——<span className="ti-rouge">你先看见的，是她后来才懂的</span>。</p>
          </div>
        </>
      ) : (
        <div className="closing-minimal">
          <h1 className="closing-minimal-title">你安静地走完了这场戏。</h1>
          <div className="closing-final">
            <p>戏台也记得这份安静。{'\n'}《牡丹亭》还有五十三出，每一出都可能等你停下。</p>
          </div>
        </div>
      )}

      {/* 批注：只保存在本地，戏台不评价 */}
      <div style={{ marginTop: '8vh', textAlign: 'center' }}>
        <button className="text-entry-small" onClick={() => setWriting(w => !w)}>
          {writing ? '收起这一笔' : '写下一句话'}
        </button>
      </div>
      {writing && (
        <div className="annotation-box">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="只写给自己看。这句话保存在本地，不会被评价。"
            aria-label="写下一句话"
            autoFocus
          />
          <div className="anno-actions">
            <button className="text-entry-small" onClick={saveAnnotation}>留在书页上</button>
            <button className="text-entry-small" onClick={() => setWriting(false)}>不写</button>
          </div>
        </div>
      )}
      {state.annotations.length > 0 && (
        <div className="annotation-list">
          {state.annotations.map(a => (
            <div className="annotation-item" key={a.id}>
              {a.text}
              <div className="anno-meta">读书批注 · 仅保存在本机</div>
            </div>
          ))}
        </div>
      )}

      <div className="closing-actions" style={{ marginTop: '6vh' }}>
        <button className="text-entry" onClick={onReopen}>回到原文</button>
        <button className="text-entry" onClick={onNextChapter}>继续读下一出</button>
      </div>
      <div className="subpage-back" style={{ marginTop: '4vh' }}>
        <button className="text-entry-small" onClick={onOpenAbout}>这本书刚才做了什么？</button>
      </div>
    </div>
  )
}
