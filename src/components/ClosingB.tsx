import { useState } from 'react'
import type { BPersisted } from '../store'
import { logBEvent } from '../store'
import { deriveWorldState } from '../world-state'

interface Props {
  state: BPersisted
  update: (fn: (s: BPersisted) => BPersisted) => void
  onReopen: () => void   // 回到原文重新选择
}

/**
 * 结尾：读法签名卡
 * 一张卡 = 读者选的针脚句 + 他的读法字(春/残/颜/梦/惊) + AI回应句
 * 可以直接截图分享。
 */
export default function ClosingB({ state, update, onReopen }: Props) {
  const activePin = state.pins.find(p => p.active)
  const pinText = activePin?.text || ''
  const agent = state.agentResponse

  // 签名卡核心：读法字 + 针脚 + 回应 并置
  const derived = deriveWorldState(pinText || null, 'garden')
  const glyph = derived.traceGlyph
  const echoText = agent?.candidateSnapshot?.sourceText
  const echoWhere = agent?.candidateSnapshot?.where

  const [draft, setDraft] = useState(state.finalUnderstanding || '')
  const [done, setDone] = useState(state.progress.finished && !!state.finalUnderstanding)

  const submitFinal = () => {
    if (!draft.trim()) return
    update(s => logBEvent(
      { ...s, finalUnderstanding: draft, progress: { ...s.progress, finished: true } },
      'submit_final',
      { length: draft.length },
    ))
    setDone(true)
  }

  return (
    <div className="b-closing">
      <header className="b-closing-head">
        <span className="b-title-mark">余韵</span>
        <h1 className="b-closing-title">读完以后</h1>
      </header>

      {/* 读法签名卡：核心视觉物，可以直接截图分享 */}
      <section className="b-signature-card" aria-label="读法签名卡">
        <div className="b-card-frame">
          <div className="b-card-head">
            <span className="b-card-play">《牡丹亭·惊梦》</span>
          </div>

          {/* 读法字：放大居中，这是读者留给自己的签名 */}
          <div className={`b-card-glyph b-card-glyph-${derived.state}`}>{glyph}</div>

          <div className="b-card-pin">
            <span className="b-card-label">你把变化的开始放在</span>
            <p className="b-card-text b-card-pin-text">
              {pinText ? `「${pinText}」` : '（未设针脚）'}
            </p>
          </div>

          <div className="b-card-arrow" aria-hidden="true">╲╱</div>

          <div className="b-card-echo">
            <span className="b-card-label">后来回应你的原文</span>
            <p className="b-card-text b-card-echo-text">
              {echoText ? `「${echoText}」` : '这本书记住了你的选择。'}
            </p>
            {echoWhere && (
              <p className="b-card-where">{echoWhere}</p>
            )}
          </div>

          <div className="b-card-foot">
            <span>可直接截图保存</span>
          </div>
        </div>
      </section>

      {/* 自由一句：不润色、不引导、只给自己看 */}
      <section className="b-final-sentence" aria-label="最终理解">
        <p className="b-final-prompt">可选：游园之后，你想留下一句什么？</p>
        <textarea
          className="b-final-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="写给自己看。不会被评价，也不由 AI 代写。可以留空。"
          rows={3}
        />
        <div className="b-final-actions">
          <button className="text-entry" onClick={submitFinal} disabled={!draft.trim()}>
            留下这句话
          </button>
          {done && <span className="b-final-done">已记下。</span>}
        </div>
      </section>

      <div className="b-closing-footer">
        <button className="text-entry-small" onClick={onReopen}>回到原文再读一遍</button>
      </div>
    </div>
  )
}
