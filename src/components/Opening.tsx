import { useCallback, useEffect, useState } from 'react'
import type { Persisted } from '../store'
import { setPerformanceMusic, stopAmbient, resumeAudio } from '../sound'

interface Props {
  state: Persisted
  onEnter: () => void
  onToggleDemoMode: () => void
}

/**
 * 开场：一张近乎空白的纸页。
 * 不介绍功能，不播放视频。点击/空格让所有等待中的文字立即显现。
 */
export default function Opening({ state, onEnter, onToggleDemoMode }: Props) {
  const [leaving, setLeaving] = useState(false)
  const [skipAll, setSkipAll] = useState(false)

  const skip = useCallback(() => setSkipAll(true), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault()
        skip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skip])

  useEffect(() => {
    setPerformanceMusic('chamber', 0.48, state.settings.sound)
    return () => stopAmbient()
  }, [state.settings.sound])

  const enter = () => {
    if (leaving) return
    resumeAudio()
    setLeaving(true)
    const wait = state.settings.motion ? 950 : 0
    window.setTimeout(onEnter, wait)
  }

  const hasProgress = state.progress.maxRevealed > 0

  return (
    <div
      className={`opening ${leaving ? 'leaving' : ''} ${skipAll ? 'skip-all' : ''}`}
      onClick={skip}
    >
      <div className="opening-prologue" aria-hidden="true">
        <div className="prologue-moon" />
        <div className="prologue-gate prologue-gate-left" />
        <div className="prologue-gate prologue-gate-right" />
        <div className="prologue-figure"><i /></div>
        <div className="prologue-peony">
          {Array.from({ length: 10 }, (_, index) => (
            <i key={index} style={{ '--opening-petal': index } as React.CSSProperties} />
          ))}
        </div>
      </div>
      <div className="opening-mode" onClick={e => e.stopPropagation()}>
        <button
          className={state.settings.demoMode ? 'on' : ''}
          onClick={() => { if (!state.settings.demoMode) onToggleDemoMode() }}
        >
          演示节选
        </button>
        <button
          className={!state.settings.demoMode ? 'on' : ''}
          onClick={() => { if (state.settings.demoMode) onToggleDemoMode() }}
        >
          完整阅读
        </button>
      </div>

      <h1 className="opening-title ink-in">牡丹亭</h1>
      <div className="opening-sub ink-in delay-1">第十出　惊梦</div>

      <div className="opening-notes ink-in delay-2">
        <span className="notes-tag">非原文 · 观戏指南</span>
        <p className="notes-lead">
          你可能读过“姹紫嫣红”，<br/>
          但还没有陪杜丽娘走完《惊梦》。<br/>
          今夜，请带着一个问题入园：
        </p>
        <p className="notes-scene">从哪一句开始，她再也回不到原来的生活？</p>
        <p className="notes-core">你留下的原文，后面会回来回应你。</p>
      </div>

      <div className="opening-enter ink-in delay-3" onClick={e => e.stopPropagation()}>
        <button className="text-entry text-entry-large" onClick={enter} aria-label="入园观戏">
          入 园 观 戏
        </button>
      </div>

      {hasProgress && (
        <div className="opening-resume ink-in delay-4" onClick={e => e.stopPropagation()}>
          <button className="text-entry-small" onClick={enter}>
            （将从上次读到的地方继续）
          </button>
        </div>
      )}
    </div>
  )
}
