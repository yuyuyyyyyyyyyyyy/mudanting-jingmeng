/**
 * 声音：入梦原型版（古乐 · 昆曲配器）
 *
 * 律制：三分损益律（黄钟 = D）
 *   宫 = 1
 *   商 = 9/8        (203.91 cents)
 *   角 = 81/64      (407.82 cents)
 *   徵 = 3/2        (701.96 cents)
 *   羽 = 27/16      (905.87 cents)
 *
 * 乐器：琵琶（丝弦、低张力、哑声倾向）
 *
 * 设计原则：
 *   - 不"配乐"，做"腔"
 *   - 没有持续 drone（持续音 = 引擎感）
 *   - 弹拨 attack 30-50ms（古琵琶"圆"触弦，无尖锐"啪"）
 *   - decay 1.0-1.8s（古琵琶共鸣短，不像吉他）
 *   - 泛音按三分损益律：基频 + 9/8 + 3/2（不是 1:2:3 整数倍）
 *   - 偶发"注"：音头极轻滑下（古乐"绰""注"）
 *   - 低通 1100Hz（更哑、更"古"）
 */

let ctx: AudioContext | null = null
let masterGain: GainNode | null = null
let lpFilter: BiquadFilterNode | null = null
let enabled = true

// 总音量（0.24 → 0.30，整体加大一档，各音效相对比例不变）
const MASTER_VOLUME = 0.30

// 黄钟 D3 = 146.83 Hz（昆曲常用调高）
const HUANGZHONG = 146.83

// 三分损益律五声音阶（昆曲正声 D 宫）
const WU_SHENG = [
  1,           // 宫
  9 / 8,       // 商
  81 / 64,     // 角（注意：不是 5/4 = 386 cents，而是 408 cents，更"古"）
  3 / 2,       // 徵
  27 / 16,     // 羽
]

function ensureCtx() {
  if (ctx) return ctx
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  ctx = new AudioCtx()
  masterGain = ctx.createGain()
  masterGain.gain.value = 0
  lpFilter = ctx.createBiquadFilter()
  lpFilter.type = 'lowpass'
  // 1100Hz：更哑，更"古"
  lpFilter.frequency.value = 1100
  lpFilter.Q.value = 0.5
  lpFilter.connect(masterGain)
  masterGain.connect(ctx.destination)
  return ctx
}

export async function resumeAudio() {
  ensureCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    try { await ctx.resume() } catch { /* ignore */ }
  }
}

/**
 * 播放一个古琵琶单音
 *
 * 三层叠加：
 *   1) 基频：三角波，attack 35ms（圆触弦），decay 1.2s
 *   2) 商音泛音：9/8 比例，gain 0.18（不是 1:2 整数）
 *   3) 徵音泛音：3/2 比例，gain 0.10
 *   不加噪声 burst（古乐无"啪"开场）
 *   偶发"注"：开头频率从 1.02 滑到 1.0
 */
function playPipaNote(
  freq: number,
  startTime: number,
  duration: number,
  peak: number,
  withZhuo: boolean = true,  // 是否带"注"（古乐润腔）
) {
  if (!ctx || !lpFilter) return

  // 整数倍谐波（电脑合成下非整数倍会形成拍频噪音）
  // 2x = 八度、3x = 八度+纯五度：温暖且绝对和谐
  const partials = [
    { ratio: 1,    gain: 1.0,  detune: 0 },   // 基频
    { ratio: 2,    gain: 0.16, detune: 0 },   // 2倍频（八度，暖）
    { ratio: 3,    gain: 0.06, detune: 0 },   // 3倍频（丝弦感）
  ]

  for (const p of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'  // 三角波，丝弦质感
    const partialFreq = freq * p.ratio

    // 音头"注"：从 1.02 滑到 1.0（古乐润腔，0.04s）
    if (withZhuo) {
      osc.frequency.setValueAtTime(partialFreq * 1.02, startTime)
      osc.frequency.exponentialRampToValueAtTime(partialFreq, startTime + 0.04)
    } else {
      osc.frequency.setValueAtTime(partialFreq, startTime)
    }
    osc.detune.value = p.detune

    const g = ctx.createGain()
    g.gain.setValueAtTime(0, startTime)
    g.gain.linearRampToValueAtTime(peak * p.gain, startTime + 0.035)  // attack 35ms（圆触弦）
    // 更快收束（原在 0.4×duration 才跌到 40%，低频下太拖 = "嗡"感）
    g.gain.exponentialRampToValueAtTime(peak * p.gain * 0.3, startTime + duration * 0.25)
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration)

    osc.connect(g)
    g.connect(lpFilter)
    osc.start(startTime)
    osc.stop(startTime + duration + 0.1)
  }
}

/**
 * 钢琴音：五声音阶的轻钢琴（远处传来，不做"人声哼唱"）
 *   - 双弦失谐（+3 / -2 cents）：钢琴琴弦的微拍质感，圆润不刺耳
 *   - 谐波 1x/2x/3x/4x：基音 + 高次谐波弱化（钢琴的泛音结构）
 *   - attack 10ms 触键 + 指数衰减余韵（琴弦渐歇）
 *   - 无 vibrato、无长吟——哼唱式长音 + 颤音最容易合成出"卡祖笛/噪音"感
 */
function playPianoNote(
  freq: number,
  startTime: number,
  duration: number,
  peak: number,
) {
  if (!ctx || !lpFilter) return
  const now = startTime
  const attack = 0.010
  const detunes = [3, -2]   // 失谐弦对：产生钢琴特有的轻微拍频
  const partials = [
    { ratio: 1, gain: 1.0 },
    { ratio: 2, gain: 0.30 },
    { ratio: 3, gain: 0.10 },
    { ratio: 4, gain: 0.035 },
  ]
  for (const p of partials) {
    for (const d of detunes) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq * p.ratio, now)
      osc.detune.value = d
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(peak * p.gain, now + attack)
      // 钢琴余韵：起音后 40% 时长内跌到 18%，duration 处收尽
      g.gain.exponentialRampToValueAtTime(peak * p.gain * 0.18, now + duration * 0.4)
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration)
      osc.connect(g)
      g.connect(lpFilter)
      osc.start(now)
      osc.stop(now + duration + 0.15)
    }
  }
}

/** 涟漪触发音：每个字一个真正不同的音
 *  5 音 × 3 八度 × 3 attack 变体 × 2 谐波配置 ≈ 90 种不同音色
 *  按 char 全码点（code point）哈希到组合空间，相邻字也容易不同。
 */
export function playRipple(strength: number = 1, char: string = '') {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !lpFilter) return
  const now = ctx.currentTime

  // 用完整 code point 哈希（首字 + 后续字若有）
  let seed = 0
  for (let i = 0; i < char.length; i++) {
    seed = (seed * 131 + char.charCodeAt(i)) >>> 0
  }

  // 5 音 × 3 八度 = 15 音
  const idx = seed % WU_SHENG.length
  const oct = (seed >>> 4) % 3  // 0,1,2 = 低/中/高八度
  // Attack 变体：60/90/120ms 三档（更柔，去掉弹拨脆感）
  const attackIdx = (seed >>> 7) % 3
  const attackMs = [0.060, 0.090, 0.120][attackIdx]
  // 时长变体：1.0/1.4/1.8s
  const durIdx = (seed >>> 11) % 3
  const duration = [1.0, 1.4, 1.8][durIdx]
  // 谐波配置：决定"亮"或"暗"
  const timbre = (seed >>> 13) % 3  // 0=原配 / 1=加 9/8 弱化 / 2=加 3/2 强化

  let baseFreq = HUANGZHONG * WU_SHENG[idx] * Math.pow(2, oct)
  baseFreq *= 0.5  // 整体下移 1 个八度（更哑、更远）
  const peak = Math.min(0.055, 0.04 * strength)

  // 三种谐波配置（全部整数倍，只改"亮/暗"不加不和谐音）
  const partials =
    timbre === 0 ? [
      { ratio: 1,   gain: 1.0,  detune: 0 },
      { ratio: 2,   gain: 0.16, detune: 0 },
      { ratio: 3,   gain: 0.06, detune: 0 },
    ] : timbre === 1 ? [
      { ratio: 1,   gain: 1.0,  detune: 0 },
      { ratio: 2,   gain: 0.08, detune: 0 },
    ] : [
      { ratio: 1,   gain: 1.0,  detune: 0 },
      { ratio: 3,   gain: 0.12, detune: 0 },
    ]

  for (const p of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    const partialFreq = baseFreq * p.ratio
    osc.frequency.setValueAtTime(partialFreq * 1.02, now)
    osc.frequency.exponentialRampToValueAtTime(partialFreq, now + 0.04)
    osc.detune.value = p.detune

    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(peak * p.gain, now + attackMs)
    g.gain.exponentialRampToValueAtTime(peak * p.gain * 0.4, now + duration * 0.4)
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    osc.connect(g)
    g.connect(lpFilter)
    osc.start(now)
    osc.stop(now + duration + 0.1)
  }
}

/**
 * 播放一声「短促拨弦」—— 内心独白的引子
 *
 * 为什么不是"古琴泛音"：sine 波 + 4-5s 长衰减 + 多层泛音 = 颂钵/水晶钵音色，
 * 正是用户反感的"疗愈音频、冥想碗"感。
 *
 * 改为：
 *   - triangle 实音（声音"近、实"，不飘）
 *   - attack 5-12ms（明确的"拨"，不是"敲"）
 *   - duration 1.0-1.6s（短促收束，不留长余音）
 *   - 只留基频 + 极弱 2x 谐波
 */
export function playQinTap(char: string = '') {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !lpFilter) return
  const now = ctx.currentTime

  // 字符哈希
  let seed = 0
  for (let i = 0; i < char.length; i++) {
    seed = (seed * 131 + char.charCodeAt(i)) >>> 0
  }

  // 5 音 × 2 八度 = 10 音
  const idx = seed % WU_SHENG.length
  const oct = (seed >>> 4) % 2  // 0=中音 1=高音
  const baseFreq = HUANGZHONG * WU_SHENG[idx] * Math.pow(2, oct)
  // 时长变体：1.0/1.3/1.6s（短促，不留"钵"式长余音）
  const durIdx = (seed >>> 7) % 3
  const duration = [1.0, 1.3, 1.6][durIdx]
  // attack 变体：5/8/12ms（明确的"拨"）
  const atkIdx = (seed >>> 11) % 3
  const attack = [0.005, 0.008, 0.012][atkIdx]

  // 单个弱泛音：基频 + 2x 少量（实音为主）
  const partials = [
    { ratio: 1, gain: 1.00, detune: 0 },
    { ratio: 2, gain: 0.10, detune: 0 },
  ]

  const peak = 0.04

  for (const p of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'  // triangle 实音；sine 长衰减 = 颂钵/冥想音色
    const partialFreq = baseFreq * p.ratio
    osc.frequency.setValueAtTime(partialFreq, now)
    osc.detune.value = p.detune

    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(peak * p.gain, now + attack)
    // 快速衰减（拨弦：起音后 0.25 内跌到 40%，1s 内收尽）
    g.gain.exponentialRampToValueAtTime(peak * p.gain * 0.4, now + duration * 0.25)
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    osc.connect(g)
    g.connect(lpFilter)
    osc.start(now)
    osc.stop(now + duration + 0.1)
  }
}

/** 首次交互解锁音频（不启动任何背景音乐——声音层只保留字音效） */
export async function unlock() {
  await resumeAudio()
}

export function setEnabled(v: boolean) {
  enabled = v
  // 即使 AudioContext 尚未创建（首次交互前），也先建好——
  // 否则 gain 保持 0，默认"声音开"却一直静音，要再点一次开关才出声。
  ensureCtx()
  if (!ctx || !masterGain) return
  const now = ctx.currentTime
  masterGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(masterGain.gain.value, now)
  masterGain.gain.linearRampToValueAtTime(v ? MASTER_VOLUME : 0, now + 0.6)
}

/**
 * 播放一个「应和」音 —— 用户停留字时，杜丽娘拨一音
 *  pentatonicIndex: 0=宫 1=商 2=角 3=徵 4=羽
 */
export function playHarmony(
  pentatonicIndex: number,
  mode: 'spring' | 'ruin' | 'self' | 'neutral' = 'neutral',
) {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !lpFilter) return

  const idx = Math.max(0, Math.min(pentatonicIndex, WU_SHENG.length - 1))
  let freq = HUANGZHONG * WU_SHENG[idx]
  if (mode === 'spring') freq *= 2     // 高八度，明亮
  if (mode === 'ruin')   freq *= 0.5   // 低八度，低沉

  const now = ctx.currentTime
  const dur = mode === 'spring' ? 1.0 : mode === 'ruin' ? 1.6 : 1.2
  const peak = 0.10  // 应和音（0.18 → 0.10，退回背景层）

  // 单音（带"注"）
  playPipaNote(freq, now + 0.05, dur, peak, true)

  // ruin 模式加一个低八度的轻"影"音
  if (mode === 'ruin') {
    playPipaNote(freq * 0.5, now + 0.18, dur + 0.4, peak * 0.4, false)
  }
}

/**
 * 背景轻音乐：连续织体（低音不断、旋律句句交叠，没有长空白）
 *   - 低音声部：长音无缝衔接，前一个未尽、下一个已起——低声部永远在
 *   - 旋律声部：小句连绵，句尾长音的余韵里叠入下一句——听感不断
 * 音量都在背景层（≤0.035），不与"滑动成曲""停留拨弦"抢
 */
let melodyLoopTimer: number | null = null
let bassStep = 0
// 当前和声的音阶位置（0宫 1商 2角 3徵 4羽）：背景和声跟着它走
let currentBassIdx = 0
// 场景氛围（起承转合）：同一句和声，按场景换"根音高低 / 音量 / 疏密"
let melodyScene: string = 'spring'

/**
 * 场景 → 背景和声配置
 *   rootOctave：根音八度（越小越低，暮色低缓、梦缥缈）
 *   peak：单音音量（背景层 ≤0.015，绝不抢主旋律）
 *   min/maxGap：和声间隔（暮色/梦更疏，留白更多）
 *   seq：和声进行（宫调式内游走）
 */
const SCENE_SOUND: Record<string, { rootOctave: number; peak: number; minGap: number; maxGap: number; seq: number[] }> = {
  spring: { rootOctave: 0.5,  peak: 0.015, minGap: 10000, maxGap: 14000, seq: [0, 3, 4, 2, 0] },
  garden: { rootOctave: 0.5,  peak: 0.015, minGap: 9000,  maxGap: 13000, seq: [0, 2, 4, 3, 0] },
  dusk:   { rootOctave: 0.35, peak: 0.012, minGap: 14000, maxGap: 18000, seq: [2, 0, 3, 1, 0] },
  dream:  { rootOctave: 0.7,  peak: 0.010, minGap: 16000, maxGap: 20000, seq: [4, 2, 0, 3, 0] },
  wake:   { rootOctave: 0.5,  peak: 0.008, minGap: 18000, maxGap: 24000, seq: [0, 0, 3, 0, 2] },
}

export function startMelodyLoop(scene: string = 'spring') {
  melodyScene = SCENE_SOUND[scene] ? scene : 'spring'
  // 切场景：清掉旧循环，用新氛围重新起（旧 timer 先停，避免两个氛围交叠）
  if (melodyLoopTimer != null) {
    window.clearTimeout(melodyLoopTimer)
    melodyLoopTimer = null
  }
  // 背景和声：按场景的疏密与音色排（根音 + 纯五度，偶加八度）
  const scheduleHarmony = () => {
    // 浏览器未解锁：不排音（避免堆在冻结的时间线上，解锁时一起爆出来）
    if (!enabled || ctx?.state === 'suspended') {
      melodyLoopTimer = window.setTimeout(scheduleHarmony, 400)
      return
    }
    playHarmonyChord(melodyScene)
    const cfg = SCENE_SOUND[melodyScene]
    const gap = cfg.minGap + Math.random() * (cfg.maxGap - cfg.minGap)
    melodyLoopTimer = window.setTimeout(scheduleHarmony, gap)
  }
  melodyLoopTimer = window.setTimeout(scheduleHarmony, 800)
}

export function stopMelodyLoop() {
  if (melodyLoopTimer) {
    window.clearTimeout(melodyLoopTimer)
    melodyLoopTimer = null
  }
}

/**
 * 背景和声：低音区的钢琴和弦（根音 + 纯五度，有时加八度），缓缓铺陈
 *  - 全是 2:1 / 3:2 的纯音程，低而暖，绝不与文字音（主旋律）抢
 *  - 每个音极轻（≤0.015），6.5s 长余韵，和声之间留 3-7s 静默
 *  - 场景不同：根音高低、音量、疏密随之而变（起承转合的声音签名）
 */
function playHarmonyChord(scene: string) {
  if (!ctx || !lpFilter) return
  const cfg = SCENE_SOUND[scene] || SCENE_SOUND.spring
  const seq = cfg.seq
  const idx = seq[bassStep % seq.length]
  bassStep++
  currentBassIdx = idx
  const root = HUANGZHONG * WU_SHENG[idx] * cfg.rootOctave  // 根音随场景升降
  const now = ctx.currentTime + 0.1
  const voices: [number, number, number][] = [
    [root, now, cfg.peak],             // 根音
    [root * 1.5, now + 0.6, cfg.peak * 0.75], // 纯五度（3:2，最协和）
  ]
  if (Math.random() < 0.6) voices.push([root * 2, now + 1.2, cfg.peak * 0.55]) // 八度（有时）
  for (const [f, t, peak] of voices) {
    playPianoNote(f, t, 6.5, peak)
  }
}

/**
 * 应允音：她把门开了——低音宫，上滑到徵，柔和而肯定（过关的仪式感）
 */
export function playGateGrant() {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !lpFilter) return
  const now = ctx.currentTime
  const root = HUANGZHONG * 0.5      // 低八度宫
  const fifth = root * 1.5           // 徵（3:2，最协和的应允）
  playPianoNote(root, now + 0.05, 2.4, 0.02)
  playPianoNote(fifth, now + 0.35, 2.8, 0.014)
}

/**
 * 收束 · 声音收尽
 * 停掉旋律循环，主音量在数秒内淡到无声（制造"全静"）。
 * 之后由 playFinalTone() 从静默中拉起一声。
 */
export function silenceOut(duration = 2.5) {
  stopMelodyLoop()
  if (!ctx || !masterGain) return
  const now = ctx.currentTime
  masterGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(masterGain.gain.value, now)
  masterGain.gain.linearRampToValueAtTime(0.0001, now + duration)
}

/**
 * 收束 · 一声
 * 从全静中拉起一声低而柔的宫音（triangle 实音，非 sine 长衰减——避免颂钵/冥想感）。
 * 呼应"留白之后的回响"：一屏尽静，只此一声。
 */
export function playFinalTone() {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !masterGain || !lpFilter) return
  const now = ctx.currentTime
  // 主音量从静默中缓缓拉起（0.8s），再落一声
  masterGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(masterGain.gain.value, now)
  masterGain.gain.linearRampToValueAtTime(MASTER_VOLUME, now + 0.8)
  // 宫音定调（146.83Hz），柔 attack，2s 衰减
  playPipaNote(HUANGZHONG * WU_SHENG[0], now + 0.9, 2.2, 0.03, false)
}

// 滑动成曲的旋律状态：划过文字 = 轻弹五声音阶，音高随已划过的字连成旋律
// 小步游走（多 ±1、少 ±2），每 8 个字一个乐句、句首落回宫/角，像起句
let swipeMelody = { idx: 0, oct: 1, count: 0 }
const SWIPE_STEPS = [-2, -1, -1, -1, 0, 1, 1, 1, 2]

function nextSwipeNote(): { idx: number; oct: number } {
  const s = swipeMelody
  s.count += 1
  // 每 8 个字一个乐句：句首回宫(0)/角(2) 交替，旋律有了"句读"
  if (s.count % 8 === 1) {
    s.idx = ((s.count >> 3) % 2 === 0) ? 0 : 2
    return { idx: s.idx, oct: s.oct }
  }
  const step = SWIPE_STEPS[Math.floor(Math.random() * SWIPE_STEPS.length)]
  s.idx = Math.max(0, Math.min(4, s.idx + step))
  return { idx: s.idx, oct: s.oct }
}

/**
 * 划过音效 —— 滑动成曲
 * 每个字一个音，五声音阶小步游走：快划过 = 快曲，慢划过 = 散曲，
 * 连起来是一段轻音乐（丝弦、低张力、圆触弦），不是孤立的单音。
 */
export function playSwipe() {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !lpFilter) return
  const note = nextSwipeNote()
  const now = ctx.currentTime
  const freq = HUANGZHONG * WU_SHENG[note.idx] * Math.pow(2, note.oct)
  const peak = 0.05
  const attack = 0.008
  const duration = 0.9
  const partials = [
    { ratio: 1, gain: 1.0, detune: 0 },
    { ratio: 2, gain: 0.08, detune: 0 },
  ]
  for (const p of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq * p.ratio, now)
    osc.detune.value = p.detune
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(peak * p.gain, now + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(g)
    g.connect(lpFilter)
    osc.start(now)
    osc.stop(now + duration + 0.05)
  }
}

/**
 * 你读出的旋律 —— 曲终收束
 * 把读者一路停留的字谱成一支小曲：
 *   - 每个字 = 五声音阶里固定的一个音（同字同音，跨次可重现）
 *   - 八度随偏向：春(spring)高、自照(self)中、残(ruin)低
 *   - 停得越久，音越重、越长（你停过的地方，曲子里就有分量）
 *   - 曲终收在宫音上（归位）
 */
export interface DwellNote { char: string; dwellMs: number; bias: 'spring' | 'ruin' | 'self' }

export function playDwellMelody(notes: DwellNote[]) {
  if (!enabled || notes.length === 0) return
  ensureCtx()
  if (!ctx || !lpFilter) return
  stopMelodyLoop() // 背景让位：静下来，只剩你读出的这一支
  const list = notes.slice(0, 14)
  let t = ctx.currentTime + 0.6
  for (const n of list) {
    let seed = 0
    for (let i = 0; i < n.char.length; i++) seed = (seed * 131 + n.char.charCodeAt(i)) >>> 0
    const idx = seed % WU_SHENG.length
    const oct = n.bias === 'spring' ? 2 : n.bias === 'ruin' ? 0 : 1
    const freq = HUANGZHONG * WU_SHENG[idx] * Math.pow(2, oct) * 0.75
    const dur = Math.min(2.6, Math.max(1.0, n.dwellMs / 1400))
    const accent = n.dwellMs >= 4000 ? 1.3 : 1.0
    playPipaNote(freq, t, dur, 0.042 * accent, true)
    t += dur * 0.72
  }
  // 收在宫上：曲终归位
  playPipaNote(HUANGZHONG * WU_SHENG[0], t + 0.35, 2.6, 0.03, false)
}

/**
 * 受赠音 —— 她送你一个字：一声清亮的高宫，再轻轻落一声徵
 * （与"索取"的应允音不同：这次是她给）
 */
export function playGiftTone() {
  if (!enabled) return
  ensureCtx()
  if (!ctx || !lpFilter) return
  const now = ctx.currentTime
  playPipaNote(HUANGZHONG * WU_SHENG[0] * 2, now + 0.05, 1.8, 0.03, true)
  playPipaNote(HUANGZHONG * WU_SHENG[3] * 2, now + 0.5, 1.6, 0.02, false)
}
