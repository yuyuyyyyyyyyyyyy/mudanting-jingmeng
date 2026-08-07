/**
 * 游园 · 30 秒最小原型
 *
 * 核心机制：
 *   - 4 句皂罗袍，每个字可被注视
 *   - 停留 ≥ 1.6s 触发涟漪 + 余韵召回
 *   - 召回成功 → 字旁出现「余」字
 *   - 点「余」字 → 该余韵从底部以胭脂色"浮起"
 *   - 30 秒后整体自然淡出
 *
 * 没有按钮、没有弹窗、没有显式选择。
 * 唯一的持续提示是右下角的「随她去」。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { GARDEN_LINES, ECHO_CANDIDATES, type EchoCandidate } from './types'
import { callWhisper } from './whisper'
import { unlock, playRipple, setEnabled, resumeAudio } from './dreamSound'
import './ripple.css'

const DWELL_MS = 1600
const TOTAL_DURATION_MS = 30_000
const FADE_OUT_MS = 4500

interface WhisperMark {
  charIndex: number
  echoId: string
  relation: string
}

export default function GardenPrototype() {
  const [soundOn, setSoundOn] = useState(true)
  const [motionOn, setMotionOn] = useState(true)
  const [vernacularOn, setVernacularOn] = useState(true)
  const [timeInScene, setTimeInScene] = useState(0)
  const [fadingOut, setFadingOut] = useState(false)
  const [whispers, setWhispers] = useState<Record<string, WhisperMark>>({})
  const [rising, setRising] = useState<{ echoId: string; text: string; relation: string; ts: number } | null>(null)
  const [ripples, setRipples] = useState<{ id: number; lineId: string; charIndex: number; x: number; y: number }[]>([])

  // 当前正在被注视的字（用于显示涟漪）
  const dwellTimerRef = useRef<number | null>(null)
  const dwellAnchorRef = useRef<{ lineId: string; charIndex: number; x: number; y: number } | null>(null)
  const startedAtRef = useRef<number>(Date.now())
  const audioUnlockedRef = useRef(false)
  const risingTimerRef = useRef<number | null>(null)
  const rippleIdRef = useRef(0)

  // 整体节奏
  useEffect(() => {
    const tick = () => {
      const elapsed = Date.now() - startedAtRef.current
      setTimeInScene(elapsed)
      if (elapsed >= TOTAL_DURATION_MS && !fadingOut) {
        setFadingOut(true)
      }
    }
    const t = window.setInterval(tick, 200)
    return () => window.clearInterval(t)
  }, [fadingOut])

  // 余韵 4s 后回落
  useEffect(() => {
    if (!rising) return
    if (risingTimerRef.current) window.clearTimeout(risingTimerRef.current)
    risingTimerRef.current = window.setTimeout(() => setRising(null), 4000)
    return () => {
      if (risingTimerRef.current) window.clearTimeout(risingTimerRef.current)
    }
  }, [rising])

  // 4s 内若用户什么都没做，自动从最中性的字位触发一次涟漪
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!dwellAnchorRef.current && Object.keys(whispers).length === 0) {
        const fallback = { lineId: 'L1', charIndex: 4, x: window.innerWidth / 2, y: window.innerHeight / 2 }
        triggerWhisper(fallback, true)
      }
    }, 4000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切声音
  useEffect(() => { setEnabled(soundOn) }, [soundOn])

  // 动效关闭：去掉 .ripple-on
  useEffect(() => {
    document.body.classList.toggle('no-motion-dream', !motionOn)
  }, [motionOn])

  async function triggerWhisper(anchor: { lineId: string; charIndex: number; x: number; y: number }, isAuto: boolean) {
    const line = GARDEN_LINES.find(l => l.id === anchor.lineId)
    if (!line) return
    const char = line.text[anchor.charIndex] || ''
    if (!char || /\s|[，。、！？]/.test(char)) return

    // 已经在该行召回过，不再召回
    if (whispers[anchor.lineId] && whispers[anchor.lineId].charIndex === anchor.charIndex) return

    if (audioUnlockedRef.current) {
      playRipple(isAuto ? 0.6 : 1.0)
    }

    // 添加涟漪
    rippleIdRef.current += 1
    const rip = { id: rippleIdRef.current, ...anchor }
    setRipples(prev => [...prev, rip])
    window.setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== rip.id))
    }, 3200)

    const result = await callWhisper(char, anchor.lineId, ECHO_CANDIDATES)
    if (!result) return
    const target = ECHO_CANDIDATES.find((c: EchoCandidate) => c.id === result.echoId)
    if (!target) return

    setWhispers(prev => ({ ...prev, [anchor.lineId]: { charIndex: anchor.charIndex, echoId: result.echoId, relation: result.relation } }))
    setRising({ echoId: result.echoId, text: target.targetText, relation: result.relation, ts: Date.now() })
  }

  function onCharEnter(lineId: string, charIndex: number, e: React.PointerEvent<HTMLSpanElement>) {
    if (fadingOut) return
    // 第一次悬停时解锁音频
    if (!audioUnlockedRef.current) {
      audioUnlockedRef.current = true
      unlock().catch(() => { /* ignore */ })
    }
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    const anchor = { lineId, charIndex, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    dwellAnchorRef.current = anchor
    if (dwellTimerRef.current) window.clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = window.setTimeout(() => {
      triggerWhisper(anchor, false)
    }, DWELL_MS)
  }

  function onCharLeave() {
    if (dwellTimerRef.current) {
      window.clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = null
    }
    dwellAnchorRef.current = null
  }

  function onYuClick(lineId: string) {
    const w = whispers[lineId]
    if (!w) return
    const target = ECHO_CANDIDATES.find(c => c.id === w.echoId)
    if (!target) return
    setRising({ echoId: w.echoId, text: target.targetText, relation: w.relation, ts: Date.now() })
    playRipple(0.7)
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  }

  const lineVernaculars: Record<string, string> = {
    L1: '原来繁盛的花，开满了。',
    L2: '却都开在了，残墙破井边。',
    L3: '良辰美景，偏偏天不作美。',
    L4: '赏心乐事，又在谁家院里？',
  }

  const progress = Math.min(1, timeInScene / TOTAL_DURATION_MS)

  return (
    <div
      className={`dream-scene ${fadingOut ? 'fading-out' : ''}`}
      style={{ ['--ink-depth' as string]: String(0.06 + progress * 0.18) }}
    >
      <div className="ink-pool" />
      <div className="ink-vignette" />

      {/* 顶部 4 控件 */}
      <div className="dream-controls">
        <button onClick={toggleFullscreen} title="全屏" aria-label="全屏">⛶</button>
        <button
          onClick={() => setVernacularOn(v => !v)}
          className={vernacularOn ? 'on' : ''}
          title="今译"
          aria-label="今译"
        >译</button>
        <button
          onClick={() => { setSoundOn(s => !s); if (!soundOn) resumeAudio() }}
          className={soundOn ? 'on' : ''}
          title="声音"
          aria-label="声音"
        >音</button>
        <button
          onClick={() => setMotionOn(m => !m)}
          className={motionOn ? 'on' : ''}
          title="动效"
          aria-label="动效"
        >动</button>
      </div>

      {/* 极淡进度（折尾位置） */}
      <div className="dream-progress" aria-hidden="true">
        <div className="dream-progress-bar" style={{ width: `${progress * 100}%` }} />
      </div>

      {/* 主体文字 */}
      <main className="dream-stage" onPointerLeave={onCharLeave}>
        <div className="verse-stack">
          {GARDEN_LINES.map((line, li) => (
            <div key={line.id} className="verse-line" style={{ ['--line-delay' as string]: `${li * 1.6}s` }}>
              <Chars
                text={line.text}
                lineId={line.id}
                onCharEnter={onCharEnter}
                onCharLeave={onCharLeave}
                whisper={whispers[line.id]}
                onYuClick={() => onYuClick(line.id)}
              />
              {vernacularOn && (
                <div className="verse-vernacular">{lineVernaculars[line.id]}</div>
              )}
            </div>
          ))}
        </div>
      </main>

      {/* 涟漪层（跟随字位） */}
      {motionOn && (
        <div className="ripple-layer" aria-hidden="true">
          {ripples.map(r => (
            <span
              key={r.id}
              className="ripple"
              style={{ left: r.x, top: r.y }}
            />
          ))}
        </div>
      )}

      {/* 浮起的余韵 */}
      {rising && (
        <div key={rising.ts} className="rising-echo">
          <span className="rising-text">{rising.text}</span>
          <span className="rising-relation">— {labelOf(rising.relation)}</span>
        </div>
      )}

      {/* 引导提示（右下角） */}
      {Object.keys(whispers).length === 0 && !fadingOut && (
        <div className="dream-hint">随她去</div>
      )}
    </div>
  )
}

function Chars({
  text, lineId, onCharEnter, onCharLeave, whisper, onYuClick,
}: {
  text: string
  lineId: string
  onCharEnter: (lineId: string, idx: number, e: React.PointerEvent<HTMLSpanElement>) => void
  onCharLeave: () => void
  whisper: WhisperMark | undefined
  onYuClick: () => void
}) {
  return (
    <span className="verse-row">
      {text.split('').map((ch, idx) => {
        const isYu = whisper && whisper.charIndex === idx
        return (
          <span key={idx} className="char-wrap">
            <span
              className={`char ${isYu ? 'dwelled' : ''}`}
              onPointerEnter={(e) => onCharEnter(lineId, idx, e)}
              onPointerLeave={onCharLeave}
            >{ch}</span>
            {isYu && (
              <button
                className="yu-glyph"
                onClick={(e) => { e.stopPropagation(); onYuClick() }}
                aria-label="看余韵"
              >余</button>
            )}
          </span>
        )
      })}
    </span>
  )
}

function labelOf(rel: string): string {
  const map: Record<string, string> = {
    缘: '有亲缘', 影: '如影', 对: '对望', 续: '续上',
    答: '回应', 起: '兴起', 落: '落下', 转: '一转', 归: '归处',
  }
  return map[rel] || '回响'
}
