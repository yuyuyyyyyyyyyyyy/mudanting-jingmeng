import { useEffect, useState } from 'react'
import type { BPersisted } from '../store'
import { logBEvent } from '../store'
import { playIntroPrelude, resumeAudio } from '../sound'

interface Props {
  state: BPersisted
  update: (fn: (s: BPersisted) => BPersisted) => void
  onEnterReading: () => void
}

/**
 * 开场：园门外
 * 不是问卷，不是输入框。是一扇半开的门，远处是春天的园子。
 * 推开门，就进去了。进来之后才开始读。
 */
export default function OpeningB({ update, onEnterReading }: Props) {
  const [entering, setEntering] = useState(false)
  const [faded, setFaded] = useState(false)
  const [tried, setTried] = useState(false)

  // 页面加载后慢慢让门"显出"
  useEffect(() => {
    const t = window.setTimeout(() => setFaded(true), 200)
    return () => window.clearTimeout(t)
  }, [])

  const enter = () => {
    if (entering) return
    setEntering(true)
    setTried(true)
    resumeAudio()
    playIntroPrelude()
    // 记录一个空的初始理解（不强制用户先答题）
    update(s => logBEvent(
      { ...s, initialUnderstanding: '' },
      'enter_garden',
      { via: 'gate' },
    ))
    // 门推开的过渡
    window.setTimeout(() => {
      onEnterReading()
    }, 1200)
  }

  return (
    <div className={`b-opening-v2 ${faded ? 'in' : ''} ${entering ? 'entering' : ''}`}>
      {/* 园林远景层（纯CSS，不依赖图片） */}
      <div className="garden-scene" aria-hidden="true">
        {/* 天空渐变：从顶部淡青到底部暖粉 */}
        <div className="sky" />
        {/* 远处山影 */}
        <div className="mountains">
          <div className="mountain mountain-1" />
          <div className="mountain mountain-2" />
          <div className="mountain mountain-3" />
        </div>
        {/* 花枝剪影（远处） */}
        <div className="branches">
          <div className="branch branch-1" />
          <div className="branch branch-2" />
          <div className="petal petal-1" />
          <div className="petal petal-2" />
          <div className="petal petal-3" />
          <div className="petal petal-4" />
        </div>
        {/* 粉墙（中景） */}
        <div className="wall" />
        {/* 半开的门（前景） */}
        <div className="gate-group">
          <div className="gate-frame">
            <div className="gate-leaf gate-left" />
            <div className="gate-leaf gate-right" />
            <div className="gate-crack" />
          </div>
        </div>
        {/* 地面 */}
        <div className="ground" />
        {/* 落花动画 */}
        <div className="falling-petals">
          {[...Array(8)].map((_, i) => (
            <div key={i} className={`fp fp-${i + 1}`} />
          ))}
        </div>
      </div>

      {/* 文字层 */}
      <div className="opening-text">
        <p className="opening-mark">游园</p>
        <h1 className="opening-title">牡丹亭</h1>
        <p className="opening-sub">第十出 · 惊梦</p>
        <p className="opening-line">原来姹紫嫣红开遍</p>
        <p className="opening-line soft">似这般都付与断井颓垣</p>

        <div className="gate-invitation">
          {!tried ? (
            <button className="gate-push" onClick={enter}>
              <span className="gate-push-text">推 门</span>
              <span className="gate-push-hint">走进这一场游园</span>
            </button>
          ) : (
            <p className="gate-entering">门开了……</p>
          )}
        </div>
      </div>
    </div>
  )
}
