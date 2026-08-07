/**
 * 开场：一张近乎空白的纸页（沿用正式版"最开始"的开场气质，纯 CSS，无图更高级）
 * 不介绍功能，不问卷。标题 + 一句邀请 + 入园观戏。
 * 进来之后，才是一页一页被 AI 看见的阅读。
 * 首页不碰音频——声音层只留给阅读里的字音效。
 */

import { useEffect, useState } from 'react'
import { resumeAudio, setEnabled, startMelodyLoop, stopMelodyLoop } from './dreamSound'
import './reader.css'

interface GardenOpeningProps {
  onEnter: () => void
  soundOn: boolean
  motionOn: boolean
  vernacularOn: boolean
  onSoundToggle: () => void
  onMotionToggle: () => void
  onVernacularToggle: () => void
}

// 流苏穗须：一束贝塞尔丝线（束箍处聚拢 → 下方散开 → 中间长两侧短圆收；中间几条缀尾珠）
const TASSEL_THREADS = Array.from({ length: 24 }, (_, i) => {
  const off = (i - 11.5) * 0.45
  const len = 58 + 12 * (1 - Math.min(Math.abs(off), 6) / 6)
  const tx = 10 + off
  const ty = 31 + len
  const d = `M 10 31 C ${(10 + off * 0.3).toFixed(1)} 40, ${(10 + off * 0.55).toFixed(1)} 47, ${tx.toFixed(1)} ${ty.toFixed(1)}`
  return { key: i, d, tx: +tx.toFixed(1), ty: +ty.toFixed(1), bead: Math.abs(off) < 1.6 }
})

export default function GardenOpening({
  onEnter,
  soundOn,
  motionOn,
  vernacularOn,
  onSoundToggle,
  onMotionToggle,
  onVernacularToggle,
}: GardenOpeningProps) {
  const [leaving, setLeaving] = useState(false)

  // 开屏起即铺开轻钢琴（清新底乐）：总音量跟随声音开关；
  // 未解锁时先静默排布，第一次交互（点入园/开声音）后自然出声
  useEffect(() => {
    setEnabled(soundOn)
    startMelodyLoop()
    return () => stopMelodyLoop()
  }, [soundOn])

  const enter = () => {
    if (leaving) return
    // 在用户手势里恢复 AudioContext，确保一入园就有声音（浏览器自动播放策略）
    resumeAudio()
    setLeaving(true)
    window.setTimeout(onEnter, 700)
  }

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  }

  // 门柱顶端的流苏（绳子+结+穗须）：鼠标滑动，它像被风拂过般摆动（CSS 变量驱动，不触发重渲染）
  function handlePendMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1   // 左 -1 ~ 右 1
    el.style.setProperty('--pend-x', nx.toFixed(3))
  }
  function handlePendLeave(e: React.MouseEvent<HTMLDivElement>) {
    e.currentTarget.style.setProperty('--pend-x', '0')
  }

  return (
    <div
      className={`opening ${leaving ? 'leaving' : ''}`}
      onMouseMove={handlePendMove}
      onMouseLeave={handlePendLeave}
    >
      {/* 顶部控件：开屏即可全屏（与内容页同一组，状态共享） */}
      <div className="dream-controls">
        <span className="dream-fs-group">
          <button className="fullscreen" onClick={toggleFullscreen} title="全屏" aria-label="全屏">⛶</button>
          <span className="fs-hint" aria-hidden="true">建议全屏体验</span>
        </span>
        <button onClick={onVernacularToggle} className={vernacularOn ? 'on' : ''} title="今译" aria-label="今译">译</button>
        <button onClick={() => { onSoundToggle(); resumeAudio() }} className={soundOn ? 'on' : ''} title="声音" aria-label="声音">音</button>
        <button onClick={onMotionToggle} className={motionOn ? 'on' : ''} title="动效" aria-label="动效">动</button>
      </div>

      <div className="opening-prologue" aria-hidden="true">
        <div className="prologue-moon" />
        <div className="prologue-gate prologue-gate-left">
          <div className="prologue-tassel" aria-hidden="true">
            <div className="tassel-sway">
              <svg className="tassel-svg" viewBox="0 0 20 110" width="20" height="110" aria-hidden="true">
                <defs>
                  <linearGradient id="mdt-tassel-g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="rgba(166, 93, 104, 0.9)" />
                    <stop offset="0.55" stopColor="rgba(166, 93, 104, 0.4)" />
                    <stop offset="1" stopColor="rgba(166, 93, 104, 0.04)" />
                  </linearGradient>
                </defs>
                {/* 挂线：两根绞线 */}
                <g className="tassel-cord">
                  <path d="M 10 0 C 9.4 8 9.6 16 10 20" stroke="rgba(178, 108, 122, 0.9)" strokeWidth="1.3" fill="none" />
                  <path d="M 10 1 C 10.7 9 10.4 17 10 20" stroke="rgba(138, 74, 88, 0.85)" strokeWidth="1.3" fill="none" />
                </g>
                {/* 结（宝盖）：双结 + 一道缠带 */}
                <g className="tassel-knot">
                  <ellipse cx="10" cy="26.5" rx="3.4" ry="1.7" fill="rgba(196, 113, 126, 0.95)" />
                  <ellipse cx="10" cy="29.8" rx="4.5" ry="2.5" fill="url(#mdt-tassel-g)" />
                  <rect x="6.3" y="27.6" width="7.4" height="1.7" rx="0.85" fill="rgba(128, 66, 78, 0.55)" />
                </g>
                {/* 穗须：束箍处聚拢 → 下方散开 → 中间长两侧短圆收；半腰束箍；中间几条缀尾珠 */}
                <g className="tassel-strands">
                  {TASSEL_THREADS.map(t => (
                    <path key={t.key} d={t.d} stroke="url(#mdt-tassel-g)" strokeWidth="0.9" fill="none" />
                  ))}
                  <rect x="7.2" y="41.6" width="5.6" height="2.4" rx="1.2" fill="rgba(140, 72, 84, 0.6)" />
                  {TASSEL_THREADS.filter(t => t.bead).map(t => (
                    <circle key={'b' + t.key} cx={t.tx} cy={t.ty + 2} r="1.15" fill="rgba(128, 66, 78, 0.85)" />
                  ))}
                </g>
              </svg>
            </div>
          </div>
        </div>
        <div className="prologue-gate prologue-gate-right" />
        <div className="prologue-peony">
          {Array.from({ length: 10 }, (_, index) => (
            <i key={index} style={{ '--opening-petal': index } as React.CSSProperties} />
          ))}
        </div>
      </div>

      <h1 className="opening-title ink-in">牡丹亭</h1>
      <div className="opening-sub ink-in delay-1">第十出　惊梦</div>

      <div className="opening-notes ink-in delay-2">
        <span className="notes-tag">互动阅读 · 两回</span>
        <p className="notes-lead">
          你可能读过“姹紫嫣红”，<br />
          但还没有陪杜丽娘走完《惊梦》。<br />
          这一回，书不翻给你看——
        </p>
        <p className="notes-scene">划过是读，停驻是听；你如何读，她如何回应。</p>
        <p className="notes-core">读完两回，她会告诉你：这一路，你停在了哪里。</p>
      </div>

      <div className="opening-enter ink-in delay-3" onClick={e => e.stopPropagation()}>
        <button className="text-entry text-entry-large" onClick={enter} aria-label="入园观戏">
          入 园 观 戏
        </button>
      </div>
    </div>
  )
}
