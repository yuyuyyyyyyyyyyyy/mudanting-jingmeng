/**
 * 声音 v17：氛围声景（soundscape）——不做"古风BGM"，做远处庭园的声音
 *
 *  v16 的问题（用户实测）：
 *   - sine 波+谐波 = 蜂鸣器/闹钟感
 *   - 每小节都有音+古筝拨 = 太密太吵，像廉价游戏BGM
 *   - 混响太干，没有空间感
 *   - 引子"咚-笛-笛-笛"像闹钟
 *
 *  v17 方向：
 *   1) 不用 sine，用 triangle 波（温暖、自然偶次谐波，接近箫/古琴的空气感）
 *   2) 强低通滤波（600-900Hz），切掉所有刺耳高频
 *   3) 大混响（2s+ 衰减，多 tap delay 模拟庭园空间）
 *   4) 极度稀疏：背景不是循环旋律，是每 6-12 秒随机一个 2-5 秒长音
 *   5) 音量极低（0.012-0.025），是"远处传来"不是"在耳边演奏"
 *   6) 不做固定 BPM 循环，散点留白
 *   7) 引子/设针脚/乐句/落板全部是长音缓入缓出，不做"咚！"的打击感
 */

// ============================================================
// 基础设施
// ============================================================

let ctx: AudioContext | null = null
let masterGain: GainNode | null = null
let reverbNode: ConvolverNode | null = null
let dryGain: GainNode | null = null
let wetGain: GainNode | null = null
let lpFilter: BiquadFilterNode | null = null

let ambientTimer: number | null = null
let scheduledTimeouts: number[] = []
let currentMode = 'chamber'
let currentBias: 'neutral' | 'spring' | 'self' | 'ruin' | 'dream' = 'neutral'
let soundEnabled = true

// 莺声
let orioleTimer: number | null = null
let orioleCount = 0
const ORIOLE_MAX = 3

// 入梦
let dreamNodes: { osc: OscillatorNode; gain: GainNode }[] = []

// 引子
let introPlayed = false

// ============================================================
// 音高系统
// ============================================================

/** 各阶段主音（Hz） */
const MODE_TONIC: Record<string, number> = {
  chamber:   261.63,  // C4（闺阁，低）
  threshold: 293.66,  // D4
  garden:    329.63,  // E4（园林，核心）
  self:      293.66,  // D4（自照）
  dream:     392.00,  // G4（入梦，高）
  wake:      0,
  aftermath: 261.63,  // C4（余韵）
}

/** 针脚偏移（半音） */
export type WorldBias = 'neutral' | 'spring' | 'self' | 'ruin' | 'dream'
const BIAS_SEMITONES: Record<WorldBias, number> = {
  neutral: 0,
  spring:  2,    // 春色亮 +2
  self:   -1,    // 自伤沉 -1
  ruin:   -3,    // 衰败暗 -3
  dream:   4,    // 入梦飘 +4
}

/** 五声音阶音程比（纯律，温暖） */
const SCALE = {
  1: 1,           // 宫
  2: 9 / 8,       // 商
  3: 5 / 4,       // 角（纯律大三度，比 81/64 更和谐）
  5: 3 / 2,       // 徵
  6: 5 / 3,       // 羽（纯律大六度）
}

function semitoneRatio(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

function getFreq(tonic: number, interval: number, octave = 0, bias?: WorldBias): number {
  const b = bias || currentBias
  return tonic * (SCALE as any)[interval] * Math.pow(2, octave) * semitoneRatio(BIAS_SEMITONES[b])
}

// ============================================================
// AudioContext 初始化
// ============================================================

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      setupChain()
    }
    return ctx
  } catch {
    return null
  }
}

/**
 * 信号链：osc → lpFilter → masterGain → [dryGain → destination]
 *                                            [wetGain → convolver → destination]
 *
 *  关键：lpFilter 强低通（700Hz），wet/dry = 35/65，混响长 2.2s
 */
function setupChain() {
  if (!ctx) return
  const ac = ctx

  // 主音量
  masterGain = ac.createGain()
  masterGain.gain.value = 0.020 // 极低音量：远处感

  // 低通滤波：700Hz 截止，去掉所有尖锐的高频
  lpFilter = ac.createBiquadFilter()
  lpFilter.type = 'lowpass'
  lpFilter.frequency.value = 700
  lpFilter.Q.value = 0.3

  // 干/湿分离
  dryGain = ac.createGain()
  wetGain = ac.createGain()
  dryGain.gain.value = 0.65
  wetGain.gain.value = 0.35

  // 卷积混响（程序化生成 2.2s 衰减脉冲，模拟庭园空间）
  reverbNode = ac.createConvolver()
  reverbNode.buffer = buildImpulseResponse(ac, 2.2, 2.5)

  // 接线
  lpFilter.connect(masterGain)
  masterGain.connect(dryGain).connect(ac.destination)
  masterGain.connect(wetGain).connect(reverbNode)
  reverbNode.connect(ac.destination)
}

/**
 * 生成指数衰减的噪声脉冲响应（模拟大空间的自然混响）
 * duration: 混响长度（秒）
 * decay: 衰减速率（越大衰减越慢，空间越大）
 */
function buildImpulseResponse(ac: AudioContext, duration: number, decay: number): AudioBuffer {
  const rate = ac.sampleRate
  const length = Math.round(rate * duration)
  const buf = ac.createBuffer(2, length, rate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      const t = i / length
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay)
    }
  }
  return buf
}

// ============================================================
// 核心音色：远处箫/古琴长音
// ============================================================

/**
 * 播放一个柔和的长音
 * - triangle 波（温暖，有自然偶次谐波）
 * - 经过强低通 + 大混响
 * - attack 长（0.6-1.2s 缓入）→ 主体 → release 长（1.5-4s 缓出）
 * - 不做任何打击感
 */
function playLongTone(
  freq: number,
  durationSec: number,
  opts: {
    gain?: number       // 峰值音量（相对master的倍数，默认1.0）
    attackSec?: number  // 缓入时间
    releaseSec?: number // 缓出时间
    octave?: number     // 额外八度偏移
  } = {},
) {
  const ac = ensureCtx(); if (!ac || !lpFilter) return
  if (ac.state === 'suspended') ac.resume().catch(() => {})
  const now = ac.currentTime
  const gainPeak = (opts.gain ?? 1.0)
  const attack = opts.attackSec ?? 0.9
  const release = opts.releaseSec ?? 2.0
  const octave = opts.octave ?? 0
  const f = freq * Math.pow(2, octave)

  // 振荡器：triangle 波（最温暖的原生波形）
  const osc = ac.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = f

  // 极轻微的频率偏移（模拟真实乐器的不完美，避免电子感）
  const detune = ac.createOscillator()
  detune.type = 'sine'
  detune.frequency.value = 0.15 // 0.15Hz 极慢颤
  const detuneGain = ac.createGain()
  detuneGain.gain.value = 1 // ±1 cents（±2 → ±1，减弱长音"嗡嗡"拍频）
  detune.connect(detuneGain).connect(osc.detune)
  detune.start(now)

  // 包络
  const g = ac.createGain()
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(gainPeak, now + attack)
  const sustainEnd = now + attack + Math.max(0.1, durationSec - attack - release)
  g.gain.setValueAtTime(gainPeak, sustainEnd)
  g.gain.exponentialRampToValueAtTime(0.001, sustainEnd + release)

  // 接线
  osc.connect(g).connect(lpFilter)
  const totalDur = attack + Math.max(0.1, durationSec - attack - release) + release + 0.3
  osc.start(now)
  osc.stop(now + totalDur)
  detune.stop(now + totalDur)
}

// ============================================================
// 背景氛围：散点长音（不是循环BGM）
// ============================================================

/** 从当前调性的五声音阶里随机选一个音（主要选 1/3/5，偶尔 2/6） */
function pickRandomDegree(): number {
  const pool = [1, 1, 1, 3, 3, 5, 5, 6, 2, 5, 3] // 加权：1/3/5更常见
  return pool[Math.floor(Math.random() * pool.length)]
}

function pickRandomOctave(): number {
  const r = Math.random()
  if (r < 0.15) return -1 // 偶尔低八度
  if (r < 0.75) return 0  // 大部分中音
  return 1                // 偶尔高八度
}

function scheduleNextAmbientNote() {
  if (ambientTimer !== null) { clearTimeout(ambientTimer); ambientTimer = null }
  if (!soundEnabled) return
  const tonic = MODE_TONIC[currentMode] || 0
  if (!tonic) return // wake = 静默

  // 6-14 秒后响下一个音（大部分时间是安静的）
  const waitMs = 6000 + Math.random() * 8000
  ambientTimer = window.setTimeout(() => {
    if (!soundEnabled) return
    const degree = pickRandomDegree()
    const octave = pickRandomOctave()
    const f = getFreq(tonic, degree, octave)
    const dur = 2.5 + Math.random() * 2.5 // 2.5-5秒长音
    playLongTone(f, dur, {
      gain: 0.7 + Math.random() * 0.3,
      attackSec: 1.0 + Math.random() * 0.5,
      releaseSec: 2.0 + Math.random() * 1.5,
    })
    scheduleNextAmbientNote()
  }, waitMs)
}

function startAmbientLoop() {
  if (ambientTimer !== null) return
  const ac = ensureCtx()
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {})
  // 第一个音 1.5-3 秒后响（不是立刻）
  ambientTimer = window.setTimeout(() => {
    ambientTimer = null
    if (!soundEnabled) return
    const tonic = MODE_TONIC[currentMode] || MODE_TONIC.garden || 0
    if (tonic) {
      // 第一个音是主音，稳稳的
      playLongTone(getFreq(tonic, 1, -1), 4.5, {
        gain: 0.8,
        attackSec: 1.5,
        releaseSec: 3.0,
      })
    }
    scheduleNextAmbientNote()
  }, 1800)
}

function stopAmbient() {
  if (ambientTimer !== null) { clearTimeout(ambientTimer); ambientTimer = null }
  for (const id of scheduledTimeouts) try { clearTimeout(id) } catch {}
  scheduledTimeouts = []
}

function switchMode(mode: string) {
  currentMode = mode
  if (mode === 'wake') {
    stopAmbient()
    return
  }
  if (soundEnabled && MODE_TONIC[mode]) {
    stopAmbient()
    // 500ms 后重新开始（给当前音自然衰减空间）
    const id = window.setTimeout(() => startAmbientLoop(), 500)
    scheduledTimeouts.push(id)
  }
}

// ============================================================
// 莺声（保留，大幅柔化）
// ============================================================

function chirpOriole() {
  const ac = ensureCtx(); if (!ac || !lpFilter) return
  if (ac.state === 'suspended') ac.resume().catch(() => {})
  const now = ac.currentTime

  // 更柔的莺声：triangle + 强低通 + 更慢滑音 + 更低音量（原 2200Hz 起偏高，听感"鸟叫电子声"）
  const notes = [
    { t: 0.00, f0: 1600, f1: 1900, gain: 0.010, dur: 0.45 },
    { t: 0.35, f0: 1400, f1: 1600, gain: 0.008, dur: 0.50 },
  ]

  for (const n of notes) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    const filt = ac.createBiquadFilter()
    filt.type = 'lowpass'; filt.frequency.value = 2000; filt.Q.value = 0.5

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(n.f0, now + n.t)
    osc.frequency.linearRampToValueAtTime(n.f1, now + n.t + 0.15)

    gain.gain.setValueAtTime(0, now + n.t)
    gain.gain.linearRampToValueAtTime(n.gain, now + n.t + 0.12)
    gain.gain.setValueAtTime(n.gain, now + n.t + 0.20)
    gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.dur)

    osc.connect(filt).connect(gain).connect(lpFilter)
    osc.start(now + n.t); osc.stop(now + n.t + n.dur + 0.1)
  }
}

function scheduleOrioleLoop() {
  stopOriole()
  if (orioleCount >= ORIOLE_MAX) return
  const delay = 5000 + Math.random() * 5000
  orioleTimer = window.setTimeout(() => {
    orioleCount += 1
    chirpOriole()
    if (orioleCount < ORIOLE_MAX) scheduleOrioleLoop()
  }, delay)
}

function stopOriole() {
  if (orioleTimer !== null) { clearTimeout(orioleTimer); orioleTimer = null }
}

// ============================================================
// 入梦音（柔化：缓入的和弦长音）
// ============================================================

export function playDreamCue(enabled: boolean) {
  if (!enabled) return
  const ac = ensureCtx(); if (!ac || !lpFilter) return
  if (ac.state === 'suspended') ac.resume().catch(() => {})
  stopDreamCue()
  const now = ac.currentTime
  // 柔和和弦：C4 + E4 + G4，4s 缓入 + 7s 缓出（原 11-13s 持续长鸣易形成"嗡"感）
  const notes = [
    { f: 261.63, peak: 0.014, start: 0.0, dur: 7 },
    { f: 329.63, peak: 0.011, start: 1.0, dur: 8 },
    { f: 392.00, peak: 0.008, start: 2.0, dur: 9 },
  ]
  dreamNodes = notes.map(p => {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    const filt = ac.createBiquadFilter()
    filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 0.3
    osc.type = 'triangle'
    osc.frequency.value = p.f
    gain.gain.setValueAtTime(0, now + p.start)
    gain.gain.linearRampToValueAtTime(p.peak, now + p.start + 4.0)
    gain.gain.setValueAtTime(p.peak, now + p.start + 6.0)
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.start + p.dur)
    osc.connect(filt).connect(gain).connect(lpFilter)
    osc.start(now + p.start)
    osc.stop(now + p.start + p.dur + 0.3)
    return { osc, gain }
  })
}

export function stopDreamCue() {
  for (const n of dreamNodes) {
    try {
      const ac = ctx
      if (ac) {
        n.gain.gain.cancelScheduledValues(ac.currentTime)
        n.gain.gain.setValueAtTime(n.gain.gain.value, ac.currentTime)
        n.gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.5)
        n.osc.stop(ac.currentTime + 0.6)
      }
    } catch {}
  }
  dreamNodes = []
}

// ============================================================
// 对外 API（保持签名兼容）
// ============================================================

export function startAmbient() {
  startAmbientLoop()
}

export { stopAmbient }

export function setPerformanceMusic(
  mode: string,
  _intensity: number,
  enabled: boolean,
  hardCut = false,
) {
  soundEnabled = enabled
  if (hardCut || mode === 'wake') {
    stopDreamCue()
    stopAmbient()
    currentMode = mode
    return
  }
  if (!enabled) {
    stopAmbient()
    return
  }
  switchMode(mode)
}

export function applyStagingCue(soundCue: string, _pace: string, _enabled: boolean) {
  if (soundCue === 'bird_distant') {
    orioleCount = 0
    scheduleOrioleLoop()
  } else {
    stopOriole()
  }
}

export function resumeAudio() {
  const ac = ensureCtx()
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {})
}

/**
 * 设针脚：世界偏移改变 + 一个 2.5s 长音（音高随 bias 变）
 * 不再有"咚"的打击感，是柔和的世界"变调"
 */
export function setWorldBias(b: WorldBias) {
  currentBias = b
  const ac = ensureCtx(); if (!ac) return
  const tonic = MODE_TONIC[currentMode] || MODE_TONIC.garden || 0
  if (tonic) {
    // 一个柔和长音：主音上方五度（徵），2.5秒，给"世界落定"感
    const f = getFreq(tonic, 5, 0, b)
    playLongTone(f, 2.8, {
      gain: 0.9,
      attackSec: 0.5,
      releaseSec: 2.2,
    })
  }
  // 背景氛围下一轮用新 bias
  if (ambientTimer) {
    // 不需要立刻重启，下一个音自然用上新 bias
  }
}

/**
 * 乐句：每段文字揭示时，响一个对应乐句的长音（不是旋律，是"气口"）
 */
export function playPhrase(blockIndex: number, mode: string) {
  const ac = ensureCtx(); if (!ac) return
  const tonic = MODE_TONIC[mode] || MODE_TONIC.garden || 0
  if (!tonic) return

  // 9段 → 9个音，按情节走向走五声音阶（不是旋律，是"走向"）
  // 低回 → 微扬 → 推 → 高点 → 落 → 再起 → 高点 → 回落 → 收
  const PHRASE_MAP: { degree: number; octave: number; dur: number; delayMs: number }[] = [
    { degree: 1, octave: -1, dur: 3.5, delayMs: 0 },    // 0 绕池游：低宫起
    { degree: 2, octave: 0,  dur: 3.0, delayMs: 400 },  // 1 步步娇：商微扬
    { degree: 3, octave: 0,  dur: 3.2, delayMs: 300 },  // 2 旁白1：角推
    { degree: 5, octave: 0,  dur: 4.0, delayMs: 0 },    // 3 皂罗袍上：徵高点
    { degree: 6, octave: 0,  dur: 3.0, delayMs: 500 },  // 4 旁白2：羽
    { degree: 3, octave: 1,  dur: 3.8, delayMs: 0 },    // 5 皂罗袍下：高角（亮）
    { degree: 5, octave: 0,  dur: 3.5, delayMs: 200 },  // 6 旁白3：徵落
    { degree: 2, octave: 0,  dur: 2.8, delayMs: 300 },  // 7 好姐姐：商回落
    { degree: 1, octave: -1, dur: 5.0, delayMs: 0 },    // 8 隔尾：低宫收
  ]
  const p = PHRASE_MAP[blockIndex] || PHRASE_MAP[0]
  const f = getFreq(tonic, p.degree, p.octave)

  const id = window.setTimeout(() => {
    playLongTone(f, p.dur, {
      gain: 0.85,
      attackSec: 0.7,
      releaseSec: p.dur * 0.6,
    })
  }, p.delayMs)
  scheduledTimeouts.push(id)
}

/**
 * 落板：Agent 回应到来时的收束音
 * 读法字对应不同音高+长度，但都是柔和长音
 */
export function playResolveBoard(glyph: string) {
  const ac = ensureCtx(); if (!ac) return
  const tonic = MODE_TONIC[currentMode] || MODE_TONIC.garden || 0
  if (!tonic) return

  const BOARD: Record<string, { degree: number; octave: number; dur: number }> = {
    '春': { degree: 6, octave: 1, dur: 4.5 },  // 高羽，亮
    '残': { degree: 1, octave: -1, dur: 5.5 }, // 低宫，沉
    '颜': { degree: 3, octave: 0, dur: 4.0 },  // 角，中
    '梦': { degree: 5, octave: 1, dur: 5.0 },  // 高徵，飘
    '惊': { degree: 2, octave: 0, dur: 3.0 },  // 商，短
  }
  const b = BOARD[glyph] || BOARD['颜']
  const f = getFreq(tonic, b.degree, b.octave)
  playLongTone(f, b.dur, {
    gain: 1.0,
    attackSec: 0.6,
    releaseSec: b.dur * 0.7,
  })
}

/** 兼容旧 API */
export function feedbackChoose() {}
export function feedbackEcho() {}
export function setAmbientDream(_on: boolean) {}

// ============================================================
// 开场引子：一个 6 秒长音，像远处一声箫
// 不是"咚-笛-笛-笛"，是一个音从远处缓缓飘来又散去
// ============================================================
export function playIntroPrelude() {
  if (introPlayed) return
  introPlayed = true
  const ac = ensureCtx(); if (!ac) return
  if (ac.state === 'suspended') ac.resume().catch(() => {})

  // E4 宫音（园林调），6秒，极缓入缓出，像远处箫声
  const tonic = MODE_TONIC.garden // E4
  playLongTone(getFreq(tonic, 1, -1), 6.0, {  // 低八度E3，更深远
    gain: 0.7,
    attackSec: 2.0,  // 2秒缓入（从虚无中飘来）
    releaseSec: 3.5, // 3.5秒缓出（渐渐消散）
  })

  // 3秒后叠一个高八度的三音（角），极轻，像泛音
  const id = window.setTimeout(() => {
    playLongTone(getFreq(tonic, 3, 0), 4.0, {
      gain: 0.3,
      attackSec: 1.5,
      releaseSec: 2.5,
    })
  }, 2500)
  scheduledTimeouts.push(id)
}
