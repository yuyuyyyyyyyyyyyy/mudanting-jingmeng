/**
 * 翻阅式 AI 阅读《牡丹亭·惊梦》—— 一页一页读 + 角色对话
 *
 * 读本：两回三页（第一回·游园 / 第二回·惊梦），一次只见一页，
 *      每一句原文下附逐句今译；鼠标扫完这一页所有的字，方可翻下一页。
 * 划过 = 读过（字变淡墨）；停驻 = 她说话（底部 AI 字幕 + 右下相识簿）；
 * 翻页 = 她也会说一句（这一页读毕，她接住你）。
 * 角色：杜丽娘。她通过你读的字跟你说话；你也可以选择开口与她对话（也可以不说）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { BOOK, GATE_TASKS, qupaiLabelOf, type BookPage, type GateTask } from './reader'
import { ECHO_CANDIDATES, biasOfChar, type CharBias } from './types'
import { callInnerVoice } from './innerVoice'
import { callWhisper } from './whisper'
import { unlock, playQinTap, playSwipe, playGateGrant, playGiftTone, resumeAudio, setEnabled, startMelodyLoop, stopMelodyLoop } from './dreamSound'
import './ripple.css'
import './reader.css'

const DWELL_1 = 500    // 初触：轻停 0.5s 即说话（原 1000，用户要求更快出效果）
const DWELL_2 = 1800   // 深驻：累计 1.8s（原 4000）
const PUNCT = /[\s，。、！？；：""''「」]/

// 离线/失败兜底：她绝不冷场——本地也有一句人话接住你
const LOCAL_CHAT_REPLIES = [
  '（她微微一愣，随即低了头。）你问到这个，我倒不知从何说起——这园子，我也是头一回来。',
  '（她想了想，轻声说）书里的道理我都背得，可今日见了这些花，才发觉书里没说的，才是要紧的。',
  '（她望着花出神）你陪我看这一程，我心里是欢喜的；有些话，我还需想一想，才好说与你听。',
  '（她抬眼看你）你问的，我记下了。只是深闺里长大的女子，有些话头一回说，总要先在心里过一遍。',
]
let chatFallbackIdx = 0
function localChatReply(): string {
  const r = LOCAL_CHAT_REPLIES[chatFallbackIdx % LOCAL_CHAT_REPLIES.length]
  chatFallbackIdx += 1
  return r
}

// 第二回·惊梦：梦里柳生的原文应答候选（全部出自《惊梦·山桃红》，AI 只能从这些里选）
const LIU_CANDIDATES = ECHO_CANDIDATES.filter(c => ['e2', 'e4', 'e5', 'e8'].includes(c.id))

// 关系标签（旧版「对望」同款）：AI 选的 relation 显示成一句人话
const RELATION_LABEL: Record<string, string> = {
  缘: '有亲缘', 影: '如影', 对: '对望', 续: '续上',
  答: '回应', 起: '兴起', 落: '落下', 转: '一转', 归: '归处',
}
function relationLabel(rel: string): string {
  return RELATION_LABEL[rel] || '回响'
}

interface VoiceLine { text: string; char: string; ts: number; level: 1 | 2; x?: number; y?: number }
interface DreamRespond { text: string; relation: string; ts: number; x?: number; y?: number }
interface TraceMark { key: string; x: number; y: number; bias: CharBias; ts: number }
interface DialogEntry { char: string; voice: string; ts: number; milestone?: boolean; gift?: boolean; qupaiLabel?: string }
// 底部角色对话：user = 你；her = 杜丽娘
// rollup = 拢起（她根据你读过的字重新说的一段话）
interface ChatMsg { role: 'user' | 'her'; text: string; ts: number; rollup?: boolean }

// 曲终一问的本地兜底（离线/断网时，她也有那一句压心头的话；联网时由 AI 自己问）
const LOCAL_FINAL_QUESTIONS = [
  '见过这满园春色，你说——我还能回得去那间深闺吗？',
  '花开了又谢，你却把姹紫嫣红带进了梦。梦醒以后，你还愿意做那被屏风关着的人吗？',
  '这一路你替我带走了一个字，留下了一个。你说，被留下的那个，还会再开吗？',
  '梦醒了，园子还在。你说，我该把这扇屏风推开，还是关上？',
]

function keyOf(pageId: string, li: number, ci: number) { return `${pageId}:${li}:${ci}` }
function charAt(key: string): string {
  const [pid, li, ci] = key.split(':')
  const p = BOOK.find(b => b.id === pid)
  return p?.lines[Number(li)]?.[Number(ci)] || ''
}
function pageById(id: string): BookPage { return BOOK.find(p => p.id === id) || BOOK[0] }

// 惊梦页（第二回）：梦里柳生登场，背景转入夜蓝/梦醒
function isDreamPage(pageId: string): boolean {
  return pageById(pageId).chapter === '第二回'
}

// ---- 收集停留证据（读过的字 → 角色的记忆） ----
function collectDwellHistory(map: Map<string, number>): { char: string; pageId: string; bias: CharBias; dwellMs: number }[] {
  const out: { char: string; pageId: string; bias: CharBias; dwellMs: number }[] = []
  for (const [k, ms] of map) {
    const ch = charAt(k)
    if (!ch) continue
    out.push({ char: ch, pageId: k.split(':')[0], bias: biasOfChar(ch), dwellMs: ms })
  }
  return out
}

// ---- 杜丽娘的人格成长层 ----
// 她不是一个静态角色：她在过剧情，和读者对话越多、读到越多，
// 她的人格就慢慢改变，逐渐知道自己是谁。
//   0 初见：只是惊——花真好，书里没说过。
//   1 怅惘：看见断井颓垣，美的东西也会谢。
//   2 自照：从花身上看见自己——被关住的人，原来是我。
//   3 惊梦：梦里有人与她说话，醒来心门再也关不上。
//   4 自知：说得越多，越清楚自己是谁——不想再被关着。
function selfAwarenessOf(dwellHistory: { pageId: string }[], dialogLen: number): number {
  let lvl = 0
  for (const d of dwellHistory) {
    if (isDreamPage(d.pageId)) lvl = Math.max(lvl, 2)
    else if (d.pageId === 'p2' || d.pageId === 'p3') lvl = Math.max(lvl, 1)
  }
  if (dialogLen >= 6) lvl = Math.max(lvl, 3)
  if (dialogLen >= 12) lvl = Math.max(lvl, 4)
  return lvl
}

function phaseOf(dwellHistory: { pageId: string }[]): string {
  return dwellHistory.some(d => isDreamPage(d.pageId)) ? '惊梦' : '游园'
}

interface GardenReaderProps {
  onReenter: () => void
  soundOn: boolean
  motionOn: boolean
  vernacularOn: boolean
  onSoundToggle: () => void
  onMotionToggle: () => void
  onVernacularToggle: () => void
}

export default function GardenReader({ onReenter, soundOn, motionOn, vernacularOn, onSoundToggle, onMotionToggle, onVernacularToggle }: GardenReaderProps) {
  const [introOn, setIntroOn] = useState(true)
  // 测试钩子：仅当 URL 带 ?dev 且 #pN 时直接跳到指定页（正常访问不受影响）
  const devJump = (() => {
    try {
      if (!new URLSearchParams(location.search).has('dev')) return -1
      const m = location.hash.match(/#(p\d+)/)
      if (!m) return -1
      return BOOK.findIndex(p => p.id === m[1])
    } catch { return -1 }
  })()
  const [pageIdx, setPageIdx] = useState(devJump >= 0 ? devJump : 0)
  const [voice, setVoice] = useState<VoiceLine | null>(null)
  const [dreamRespond, setDreamRespond] = useState<DreamRespond | null>(null)
  const [readTick, setReadTick] = useState(0)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number; strength: number }[]>([])
  const [traces, setTraces] = useState<TraceMark[]>([])
  // 相识簿：你停过的字 + 她说的话，一条条攒下来、不淡出
  const [dialog, setDialog] = useState<DialogEntry[]>([])
  // 左下读书卡片：她的话 + 你的话
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  // 她把门：读尽一页 → 她开口给任务 → 你在原文里点一个字给她 → 应允后才许翻页
  const [gate, setGate] = useState<'locked' | 'speaking' | 'asking' | 'granted'>('locked')
  const gateHandledRef = useRef<Set<string>>(new Set())
  // 她的任务话 / 行动引导 / 你点字后她的回应
  const [gateAsk, setGateAsk] = useState<string | null>(null)
  const [gateHint, setGateHint] = useState<string | null>(null)
  const [gateReply, setGateReply] = useState<string | null>(null)
  // 最新 gate / pageIdx 镜像：供 setTimeout / async 里读取，避免闭包读到旧值
  const gateRef = useRef(gate)
  gateRef.current = gate
  const pageIdxRef = useRef(pageIdx)
  pageIdxRef.current = pageIdx
  // p1 取舍：她带走/留下的字（结尾回响用）
  const carriedRef = useRef<{ char: string; keptLabel: string; leftPhrase: string } | null>(null)
  // 衔字：上一页停过的字，跟着你走到下一页纸角
  const [carryMarks, setCarryMarks] = useState<string[]>([])
  const carryTimerRef = useRef<number | null>(null)
  // p3 挽留：长按蓄力的字
  const [holdingKey, setHoldingKey] = useState<string | null>(null)
  const holdRef = useRef<{ key: string; ch: string; timer: number } | null>(null)
  // 4 秒无动作自动过关（防断流）
  const autoGateTimerRef = useRef<number | null>(null)
  // 轻声提醒次数：读者迟疑时最多提醒 2 次，之后静静等待，绝不刷屏
  const autoNudgeRef = useRef(0)
  // 曲终收束：旋律 + 她问的核心问题 + 答案 + 合卷题签
  const [finale, setFinale] = useState<{ text: string; carried: string } | null>(null)
  const [finaleQuestion, setFinaleQuestion] = useState<string | null>(null)
  const [finaleAnswer, setFinaleAnswer] = useState('')
  const [finaleAnswered, setFinaleAnswered] = useState(false)
  const finaleDoneRef = useRef(false)

  const lastMilestoneRef = useRef(0)
  // 游园页：她的短句轮次（最新一次停留拥有最大序号，旧响应不得覆盖）
  const voiceSeqRef = useRef(0)
  // 惊梦页：双声回合轮次——柳生（男）与杜丽娘（女）同轮生成、同轮出口、同轮作废
  const dreamTurnRef = useRef(0)
  // 柳生已回过的句子先让位，四句都回过再从头（防"一直重复"）
  const playedEchoIdsRef = useRef<Set<string>>(new Set())
  
  // ---- Agent·Memory ----
  const readSetRef = useRef<Set<string>>(new Set())       // 划过即读过
  const dwellMapRef = useRef<Map<string, number>>(new Map()) // 每字累计停留 ms
  const pageDwelledRef = useRef<Set<string>>(new Set())   // 本回停过的字
  const recentVoicesRef = useRef<string[]>([])

  // 停留计时：划过 = 只读；鼠标静止 1s / 4s 才说短句（移动中不断重置）
  const hoverRef = useRef<{ pageId: string; key: string; char: string; start: number; x: number; y: number } | null>(null)
  const timer1Ref = useRef<number | null>(null)
  const timer2Ref = useRef<number | null>(null)
  // 静止检测节流：鼠标移动时刷新停留起点，静止才说话
  const lastMoveResetRef = useRef(0)
  // 点击锁定：点击出对话后，短暂抑制停留短句（防"点击的同时又停留"）
  const clickGuardUntilRef = useRef(0)
  // 对话防抖：同一字短时间内只出一句对话（防连点重复）
  const lastDialogueRef = useRef<{ char: string; ts: number } | null>(null)
  const audioUnlockedRef = useRef(false)
  const rippleIdRef = useRef(0)
  const soundOnRef = useRef(true)
  soundOnRef.current = soundOn

  // 节流划过音：放宽到 200ms，让"滑动成曲"快划时连得起来
  const lastSwipeAtRef = useRef(0)
  const lastSwipeCharRef = useRef('')
  const SWIPE_THROTTLE_MS = 200

  // 翻页观察的上下文：上一页停过的字 + 上一句心声（让下一句接上）
  const lastPageDwelledRef = useRef('')
  // 翻页时舞台回到顶部
  const stageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { setEnabled(soundOn) }, [soundOn])
  useEffect(() => { document.body.classList.toggle('no-motion-dream', !motionOn) }, [motionOn])

  // 背景轻音乐：场景氛围随页推进（起承转合各得其声），离园即止
  useEffect(() => {
    resumeAudio()
    startMelodyLoop(BOOK[pageIdx].scene)
    return () => stopMelodyLoop()
  }, [pageIdx])

  // 预载全部场景画（后台下载，不抢主线程）：点字浮现/翻页切景时从缓存秒显，
  // 避免公网窄带宽下场景画现场下载造成的"卡一下"
  useEffect(() => {
    const seen = new Set<string>()
    for (const p of BOOK) {
      if (!p.image || seen.has(p.image)) continue
      seen.add(p.image)
      const img = new Image()
      img.src = p.image
    }
  }, [])

  // 心声 3s 自动收起；柳生的话 5s 淡出
  useEffect(() => {
    if (!voice) return
    // 惊梦页（dream）：女声明明常驻槽位，不自动收起——停留一次说一句，下一句顶替上一句；
    // 游园页：她的话只在停留那 3 秒里浮一下，过后自己收起（进右下相识簿留存）
    if (BOOK[pageIdx].dream) return
    const t = window.setTimeout(() => setVoice(null), 3000)
    return () => window.clearTimeout(t)
  }, [voice, pageIdx])
  useEffect(() => {
    if (!dreamRespond) return
    // 惊梦页（dream）：柳生常驻槽位，不自动收起——停留一次说一句，下一句顶替上一句
    if (BOOK[pageIdx].dream) return
    const t = window.setTimeout(() => setDreamRespond(null), 5200)
    return () => window.clearTimeout(t)
  }, [dreamRespond, pageIdx])

  // ---- Agent·State：读者走来的路 ----
  function deriveEvidence() {
    const path: { char: string; bias: string; lineId: string }[] = []
    const scores = { spring: 0, ruin: 0, self: 0 }
    for (const [k, ms] of dwellMapRef.current) {
      if (ms < 1000) continue
      const ch = charAt(k)
      if (!ch) continue
      const bias = biasOfChar(ch)
      path.push({ char: ch, bias, lineId: k.split(':')[0] })
      scores[bias] += 1
    }
    return { dwellPath: path.slice(-12), scores }
  }

  function addRipple(x: number, y: number, strength: number) {
    rippleIdRef.current += 1
    const id = rippleIdRef.current
    setRipples(prev => [...prev, { id, x, y, strength }])
    window.setTimeout(() => setRipples(prev => prev.filter(r => r.id !== id)), 3200)
  }

  function accumulate(key: string, ms: number) {
    dwellMapRef.current.set(key, (dwellMapRef.current.get(key) || 0) + ms)
  }

  function clearTimers() {
    if (timer1Ref.current) { window.clearTimeout(timer1Ref.current); timer1Ref.current = null }
    if (timer2Ref.current) { window.clearTimeout(timer2Ref.current); timer2Ref.current = null }
  }

  // ---- 划过 = 只读（读过 + 一声弦），不打扰、不触发说话 ----
  function onCharEnter(pageId: string, lineIdx: number, charIdx: number, e: React.PointerEvent<HTMLSpanElement>) {
    const page = pageById(pageId)
    const ch = page.lines[lineIdx]?.[charIdx]
    if (!ch || PUNCT.test(ch)) return

    const key = keyOf(pageId, lineIdx, charIdx)
    if (!readSetRef.current.has(key)) {
      readSetRef.current.add(key)
      setReadTick(t => t + 1)
    }
    if (!audioUnlockedRef.current) {
      audioUnlockedRef.current = true
      unlock().catch(() => {})
    }
    // 划过即有声音：极轻一弦（节流 + 同字不重复）
    if (soundOnRef.current) {
      const nowMs = Date.now()
      if (nowMs - lastSwipeAtRef.current > SWIPE_THROTTLE_MS && lastSwipeCharRef.current !== ch) {
        lastSwipeAtRef.current = nowMs
        lastSwipeCharRef.current = ch
        playSwipe()
      }
    }
    // 立即取坐标——合成事件在 setTimeout 后失效，先存下来
    const rect = e.currentTarget.getBoundingClientRect()
    const now = Date.now()
    hoverRef.current = {
      pageId, key, char: ch, start: now,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }
    // 划过新字：收起旧短句（她的话只回应你此刻停的地方）
    // 相会页例外：她的心声在整段文字下方的常驻槽位，不随划过清掉（3s 后自行收起）
    clearTimers()
    if (!pageById(pageId).dream) setVoice(null)
    // 不在进入时启动计时——"停留"由静止检测负责（onStagePointerMove 持续重置）
  }

  // ---- 静止检测：鼠标在字上移动 → 不断重置计时；停住 1s / 4s 才说短句 ----
  function onStagePointerMove() {
    const h = hoverRef.current
    if (!h) return
    // 刚点击过（对话已出）：短暂不触发停留短句，避免与对话重叠
    if (Date.now() < clickGuardUntilRef.current) return
    const now = Date.now()
    if (now - lastMoveResetRef.current < 150) return
    lastMoveResetRef.current = now
    clearTimers()
    timer1Ref.current = window.setTimeout(() => fireVoice(h.pageId, h.char, 1), DWELL_1)
    timer2Ref.current = window.setTimeout(() => fireVoice(h.pageId, h.char, 2), DWELL_2)
  }

  function onCharLeave(pageId: string, lineIdx: number, charIdx: number) {
    const h = hoverRef.current
    if (h) {
      accumulate(h.key, Date.now() - h.start)
      hoverRef.current = null
    }
    clearTimers()
    // 相会页（第二回·惊梦）：女声明明常驻槽位，移到下一个字也不清掉——只由下一句顶替；
    // 游园页：收起旧心声（在途的心声仍会出口——你停过，她就要说；是否作废由新一轮停留的序号决定）
    if (!pageById(pageId).dream) setVoice(null)
  }

  // ---- 停留：短句（她接住你，说一句心里的话）
  //      点击：对话（她抬起头，与你说话，进左下卡片）----
  // 惊梦页双声 = 一个回合：柳生（男）与杜丽娘（女）同轮生成、同轮出口、同轮作废。
  async function fireVoice(pageId: string, ch: string, level: 1 | 2, dialogue = false) {
    const h = hoverRef.current
    if (!h || h.char !== ch) return
    const dwellMs = dialogue ? DWELL_1 : (level === 1 ? DWELL_1 : DWELL_2)
    accumulate(h.key, dwellMs)
    pageDwelledRef.current.add(ch)

    // 动效：涟漪 + 墨点 + 一声
    addRipple(h.x, h.y, dialogue || level === 2 ? 1.25 : 1.0)
    if (soundOnRef.current) playQinTap(ch)
    const traceTs = Date.now()
    setTraces(prev => [...prev, { key: h.key, x: h.x, y: h.y, bias: biasOfChar(ch), ts: traceTs }])
    window.setTimeout(() => {
      setTraces(prev => prev.filter(t => !(t.key === h.key && t.ts === traceTs)))
    }, 3600)

    const page = pageById(pageId)
    const count = distinctDwelledCount()
    const isMilestone = count >= lastMilestoneRef.current + 3

    // ── 惊梦页：双声回合（柳生 + 她）──
    // 同一个 turnId 绑定男声女声：返回后先校验轮次，任一作废整轮撤销——
    // 绝不出现"男2+女1""答上一个字""旧字浮错位"。
    if (page.dream) {
      // 入梦页的"停留即缘"门：任何停留都计数（哪怕轻划过）
      const gTask = GATE_TASKS[page.id]
      if (gateRef.current === 'asking' && gTask?.mode === 'dwell') countAndMaybeGrantDwell(gTask)
      // 频次：轻划过只留涟漪琴声，不出口双声；深驻（4s）或点击才说话
      if (!dialogue && level !== 2) return

      const turnId = ++dreamTurnRef.current
      let pool = LIU_CANDIDATES.filter(c => !playedEchoIdsRef.current.has(c.id))
      if (!pool.length) { playedEchoIdsRef.current.clear(); pool = LIU_CANDIDATES }
      const [w, result] = await Promise.all([
        callWhisper(ch, pageId, pool),
        callInnerVoice({
          char: ch,
          lineId: pageId,
          lineText: page.lines?.join('，') || '',
          phase: '痛悟',
          dwellMs,
          recentVoices: recentVoicesRef.current.slice(-4),
          evidence: deriveEvidence(),
          dwellLevel: dialogue ? 2 : level,
          milestone: isMilestone,
          dialogue,
        }),
      ])
      // 整轮作废：期间已有更新的停留/点击/翻页（turnId 已变），旧字旧位置一律不出口
      if (turnId !== dreamTurnRef.current) return
      const target = w
        ? pool.find(c => c.id === w.echoId)
        // 服务端没选出亲缘句（或失败）→ 本地从未回过句里取一条，保证柳生必答且不重复
        : (() => {
            const unplayed = pool.filter(c => !playedEchoIdsRef.current.has(c.id))
            return unplayed[Math.floor(Math.random() * unplayed.length)]
          })()
      if (!target || !result) return
      playedEchoIdsRef.current.add(target.id)
      recentVoicesRef.current.push(result.voice)
      if (recentVoicesRef.current.length > 8) recentVoicesRef.current.shift()
      if (dialogue) {
        // 点击 = 对话：柳生浮字 + 她的话进左下卡片；字下不浮——同一句只出现一处
        setDreamRespond({ text: target.targetText, relation: w?.relation || '缘', ts: Date.now() })
        setChatMsgs(prev => [...prev, { role: 'her' as const, text: result.voice, ts: Date.now() }].slice(-40))
      } else {
        // 深驻 = 双声：柳生青墨浮上方，她胭脂落字下，同轮成对
        setDreamRespond({ text: target.targetText, relation: w?.relation || '缘', ts: Date.now() })
        setVoice({ text: result.voice, char: result.basedOn || ch, ts: Date.now(), level: 2, x: h.x, y: h.y })
      }
      return
    }

    // ── 游园页：她的短句 ──
    if (isMilestone) lastMilestoneRef.current = count
    const seq = ++voiceSeqRef.current
    const result = await callInnerVoice({
      char: ch,
      lineId: pageId,
      lineText: page.lines?.join('，') || '',
      phase: page.scene === 'garden' || page.scene === 'dusk' ? '疑问' : '惊叹',
      dwellMs,
      recentVoices: recentVoicesRef.current.slice(-4),
      evidence: deriveEvidence(),
      dwellLevel: dialogue ? 2 : level,
      milestone: isMilestone,
      dialogue,
    })
    if (!result) return
    if (seq !== voiceSeqRef.current) return // 严格守卫：只认最新一次停留（1s→4s 升级不双出）
    recentVoicesRef.current.push(result.voice)
    if (recentVoicesRef.current.length > 8) recentVoicesRef.current.shift()
    if (dialogue) {
      // 点击 = 对话：进左下卡片，你可以顺着说下去
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: result.voice, ts: Date.now() }].slice(-40))
    } else {
      // 停留 = 短句：进右下的相识簿（她记住的话），不与对话混
      setDialog(prev => [...prev, {
        char: result.basedOn || ch,
        voice: result.voice,
        ts: Date.now(),
        milestone: isMilestone,
        // 板眼：这一句是这支曲牌的第几句（昆曲的句位）
        qupaiLabel: qupaiLabelOf(page.id, Number(h.key.split(':')[1]) || 0),
      }].slice(-20))
    }
  }

  // ---- 点击一个字：她抬起头与你说话（对话，不是短句） ----
  function handleCharClick(pageId: string, lineIdx: number, charIdx: number, e: React.MouseEvent<HTMLSpanElement>) {
    const page = pageById(pageId)
    const ch = page.lines[lineIdx]?.[charIdx]
    if (!ch || PUNCT.test(ch)) return
    // 过关态：她把门，点字 = 把字指给她看（不是普通对话）
    // 入梦页例外：梦里不"点字过关"，点击也只算停一处，由停留判定放行
    if (gate === 'asking') {
      const task = GATE_TASKS[page.id]
      if (task?.mode !== 'dwell') {
        if (soundOnRef.current) playQinTap(ch)
        answerGateChar(ch)
        return
      }
    }
    // 防抖：同一个字 3s 内连点，只出一次对话（不重复说）
    const now = Date.now()
    const last = lastDialogueRef.current
    if (last && last.char === ch && now - last.ts < 3000) return
    lastDialogueRef.current = { char: ch, ts: now }
    // 划过已设好悬停点；若是键盘/直接点击，现取坐标
    if (!hoverRef.current || hoverRef.current.char !== ch) {
      const rect = e.currentTarget.getBoundingClientRect()
      hoverRef.current = {
        pageId, key: keyOf(pageId, lineIdx, charIdx), char: ch,
        start: Date.now(),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
    }
    clearTimers()
    // 点击锁定：1.6s 内静止也不触发停留短句，避免"点击的同时又停留"
    clickGuardUntilRef.current = Date.now() + 1600
    fireVoice(pageId, ch, 1, true)
  }

  // ---- 相识簿：停过的不同字数（跨回累计） ----
  function distinctDwelledCount(): number {
    let n = 0
    for (const [, ms] of dwellMapRef.current) if (ms >= DWELL_1) n += 1
    return n
  }

  // ---- 翻页门槛：这一页所有字都被划过（读过），方可往下翻 ----
  function pageCompleteFor(pageId: string): boolean {
    const page = pageById(pageId)
    let missing = 0
    page.lines.forEach((line, li) => {
      line.split('').forEach((ch, ci) => {
        if (PUNCT.test(ch)) return
        if (!readSetRef.current.has(keyOf(pageId, li, ci))) missing += 1
      })
    })
    return missing === 0
  }

  function countReadOnPage(pageId: string): number {
    const page = pageById(pageId)
    let n = 0
    page.lines.forEach((line, li) => {
      line.split('').forEach((ch, ci) => {
        if (PUNCT.test(ch)) return
        if (readSetRef.current.has(keyOf(pageId, li, ci))) n += 1
      })
    })
    return n
  }

  function collectPageDwelled(pageId: string): string {
    const page = pageById(pageId)
    const out: string[] = []
    page.lines.forEach((line, li) => {
      line.split('').forEach((ch, ci) => {
        const key = keyOf(pageId, li, ci)
        const ms = dwellMapRef.current.get(key) || 0
        if (ch && !PUNCT.test(ch) && ms >= DWELL_1) out.push(ch)
      })
    })
    return out.join('')
  }

  // ---- 她把门：下一幕的氛围词（供她预告）----
  const SCENE_LABEL: Record<string, string> = {
    spring: '春色正好',
    garden: '庭园日暖',
    dusk: '暮色四合',
    dream: '柳生入梦',
    wake: '梦将醒时',
  }
  // 本地兜底：她应允 + 预告（网络不通时也不冷场）
  const GATE_FALLBACK: Record<string, string> = {
    spring: '天光正好，随我往园子里头去罢。',
    garden: '春色还看不够，随我再往里走。',
    dusk: '暮色要合上来了，随我往花深处去。',
    dream: '我有些困了，随我入梦去罢。',
    wake: '梦要醒了，你且陪我醒一醒。',
  }
  function localPageNote(dwelledChars: string, next?: BookPage): string {
    const gate = next ? (GATE_FALLBACK[next.scene] || '随我往深处走罢。') : '随我往深处走罢。'
    return dwelledChars ? `你在「${dwelledChars}」上停了停，我记下了。${gate}` : gate
  }

  // ---- 她把门：读尽一页 → 她开口（观察本页读法 + 预告下一幕 + 应允） ----
  async function fireGateNote(page: BookPage) {
    const dwelled = collectPageDwelled(page.id)
    lastPageDwelledRef.current = dwelled
    const next = BOOK[pageIdx + 1]
    const note = await (async () => {
      try {
        const resp = await fetch('/api/page-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pageId: page.id,
            pageTitle: `${page.chapter}·${page.chapterTitle}`,
            pageText: page.lines.join('，'),
            nextTitle: next ? `${next.chapter}·${next.chapterTitle}` : '',
            nextSceneLabel: next ? SCENE_LABEL[next.scene] : '',
            stats: { readCount: countReadOnPage(page.id), dwelledChars: dwelled, pageComplete: true },
            recentVoices: recentVoicesRef.current.slice(-4),
            threadContext: { dwelled: lastPageDwelledRef.current, lastVoice: recentVoicesRef.current.slice(-1)[0] || '' },
          }),
        })
        const data = await resp.json().catch(() => null)
        const n = (data && typeof data.note === 'string' && data.note.trim()) ? data.note : ''
        return n || localPageNote(dwelled, next)
      } catch {
        return localPageNote(dwelled, next)
      }
    })()
    if (!note) { setGate('granted'); return }
    setChatMsgs(prev => [...prev, { role: 'her' as const, text: note, ts: Date.now() }].slice(-40))
    // 她说完观察与预告，接着给一个"任务"——你在这一页里点一个字给她，才算过关
    const task = GATE_TASKS[page.id]
    if (task) {
      setGateAsk(task.ask)
      setGateHint(task.hint)
      setGateReply(null)
      setGate('asking')
      armAutoGate() // 4s 无动作自动过关（梦里除外）
    } else {
      setGate('granted')
    }
  }

  // ---- 自动过关（4s 无动作防断流；梦里不自动，停留是梦的本身）----
  function clearAutoGate() {
    if (autoGateTimerRef.current) { window.clearTimeout(autoGateTimerRef.current); autoGateTimerRef.current = null }
  }
  // ---- 自动提醒：读者迟疑时她轻声提示，但绝不替读者做决定 ----
  function autoNudgeFor(task: GateTask): string {
    switch (task.mode) {
      case 'hold': return '春不等人——你替我按住那朵牡丹，别放手。'
      case 'tradeoff': return '园子不等人——你替我带走一个字，另一个，就留在这里。'
      case 'gift': return '你不收，我送不出去。你点一个字，我便送你。'
      case 'keep': return '临别了，你带走一个字作纪念罢。'
      default: return '你在这页里，替我点一个字。'
    }
  }
  function armAutoGate() {
    clearAutoGate()
    const task = GATE_TASKS[BOOK[pageIdxRef.current].id]
    if (!task || task.mode === 'dwell') return
    if (autoNudgeRef.current >= 2) return // 提醒已够，静静等她回应
    autoGateTimerRef.current = window.setTimeout(() => {
      if (gateRef.current !== 'asking') return
      const t = GATE_TASKS[BOOK[pageIdxRef.current].id]
      if (!t) return
      autoNudgeRef.current += 1
      // 取舍/受赠/挽留/纪念都是读者的选择——她只提醒，不代做，也不假装你做了
      const tip = autoNudgeFor(t)
      setGateReply(tip)
      setChatMsgs(prev => {
        // 去重：与上一条相同就不入列，防刷屏
        if (prev.length && prev[prev.length - 1].text === tip) return prev
        return [...prev, { role: 'her' as const, text: tip, ts: Date.now() }].slice(-40)
      })
      armAutoGate()
    }, 4000)
  }

  // ---- 过关仪式：她应允了 ----
  function grantGate(reply: string) {
    setGateReply(reply)
    setChatMsgs(prev => [...prev, { role: 'her' as const, text: reply, ts: Date.now() }].slice(-40))
    if (soundOnRef.current) playGateGrant()
    setGate('granted')
    // 合·梦醒：最后一页应允 → 收束（旋律 + 她问核心问题）
    if (pageIdxRef.current === BOOK.length - 1) scheduleFinale()
  }

  // ---- dwell 门：这一页停过（≥1s）的不同字数 ----
  function countDwelledOnPage(pageId: string): number {
    let n = 0
    for (const [k, ms] of dwellMapRef.current) {
      if (k.split(':')[0] !== pageId) continue
      if (ms >= DWELL_1) n += 1
    }
    return n
  }
  function countAndMaybeGrantDwell(task: GateTask) {
    const need = task.dwellNeed ?? 2
    if (countDwelledOnPage(BOOK[pageIdxRef.current].id) >= need) {
      grantGate(task.replyTarget || '')
    } else {
      const tip = task.replyOther || '还差一处——再停一处，梦便成了。'
      setGateReply(tip)
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: tip, ts: Date.now() }].slice(-40))
    }
  }

  // ---- p3 挽留门：按住将谢的牡丹 ----
  function startHold(pageId: string, li: number, ci: number, ch: string) {
    if (gateRef.current !== 'asking') return
    const task = GATE_TASKS[pageId]
    if (!task || task.mode !== 'hold') return
    const key = keyOf(pageId, li, ci)
    setHoldingKey(key)
    holdRef.current = {
      key,
      ch,
      timer: window.setTimeout(() => completeHold(ch), task.holdMs || 1600),
    }
  }
  function cancelHold() {
    if (holdRef.current) { window.clearTimeout(holdRef.current.timer); holdRef.current = null }
    setHoldingKey(null)
  }
  function completeHold(ch: string) {
    if (holdRef.current) { window.clearTimeout(holdRef.current.timer); holdRef.current = null }
    setHoldingKey(null)
    if (gateRef.current !== 'asking') return
    const task = GATE_TASKS[BOOK[pageIdxRef.current].id]
    if (!task || task.mode !== 'hold') return
    if (task.target?.includes(ch)) {
      grantGate(task.replyTarget || '')
    } else {
      const tip = task.replyOther || '不是这朵——按住那占不得先的牡丹。'
      setGateReply(tip)
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: tip, ts: Date.now() }].slice(-40))
    }
  }

  // ---- 过关玩法：五幕五种把门——取舍 / 受赠 / 挽留 / 停留即缘 / 纪念 ----
  function answerGateChar(ch: string) {
    if (gateRef.current !== 'asking') return
    const task = GATE_TASKS[BOOK[pageIdxRef.current].id]
    if (!task) { setGate('granted'); return }
    clearAutoGate()

    // 挽留：点击不算按住——她请你按住它，别放手
    if (task.mode === 'hold') {
      const hit = task.target?.includes(ch)
      const tip = hit
        ? '要按住它，不是点一下。按住「牡丹」，别放手。'
        : (task.replyOther || '不是这朵——按住那占不得先的牡丹。')
      setGateReply(tip)
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: tip, ts: Date.now() }].slice(-40))
      armAutoGate()
      return
    }

    // 取舍：带走一个字，另一个留在园里（结尾回响）
    if (task.mode === 'tradeoff' && task.tradeoff) {
      const { keep, letGo, neither } = task.tradeoff
      if (keep.chars.includes(ch)) {
        carriedRef.current = { char: ch, keptLabel: keep.label, leftPhrase: letGo.phrase }
        grantGate(keep.reply)
      } else if (letGo.chars.includes(ch)) {
        carriedRef.current = { char: ch, keptLabel: letGo.label, leftPhrase: keep.phrase }
        grantGate(letGo.reply)
      } else {
        setGateReply(neither)
        setChatMsgs(prev => [...prev, { role: 'her' as const, text: neither, ts: Date.now() }].slice(-40))
        armAutoGate()
      }
      return
    }

    // 受赠：她送你一个字（命中她心里的字，应得更深）
    if (task.mode === 'gift') {
      const hit = task.target?.includes(ch) ?? false
      const reply = (hit ? task.replyTarget || '' : task.replyOther || '').replace('X', ch)
      if (hit) {
        setDialog(prev => [...prev, { char: ch, voice: reply, ts: Date.now(), gift: true }].slice(-20))
        if (soundOnRef.current) playGiftTone()
      }
      grantGate(reply)
      return
    }

    // 纪念 / 默认点字
    const hit = !task.target || task.target.length === 0 || task.target.includes(ch)
    const reply = hit ? task.replyTarget : task.replyOther
    if (hit) {
      grantGate(reply || '')
    } else {
      setGateReply(reply || '')
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: reply || '', ts: Date.now() }].slice(-40))
      armAutoGate()
    }
  }

  // 她把门：本页读尽 → 她开口给任务；你点字应过她，翻页才解锁
  useEffect(() => {
    const page = BOOK[pageIdx]
    if (!pageCompleteFor(page.id)) { setGate('locked'); return }
    if (gateHandledRef.current.has(page.id)) {
      // 回退到这页：她已应允过，直接解锁；若她还在等，可以再点
      const task = GATE_TASKS[page.id]
      setGateAsk(task?.ask ?? null)
      setGateHint(task?.hint ?? null)
      setGate('granted')
      return
    }
    gateHandledRef.current.add(page.id)
    setGate('speaking')
    fireGateNote(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readTick, pageIdx])

  function goNext() {
    if (pageIdx >= BOOK.length - 1) return
    const page = pageById(BOOK[pageIdx].id)
    if (!pageCompleteFor(page.id)) return
    if (gate !== 'granted') return  // 她未应允，不许翻页
    // 翻页：作废在途心声、收起旧心声与柳生应答、清掉本页墨渍
    clearTimers()
    clearAutoGate()
    autoNudgeRef.current = 0 // 新一页，提醒计数清零
    cancelHold()
    voiceSeqRef.current += 1
    dreamTurnRef.current += 1
    setVoice(null)
    setDreamRespond(null)
    setTraces([])
    setGate('locked')
    setGateReply(null)
    // 衔字：上一页你停过的字，跟着你走到下一页纸角（数秒后淡去）
    const carriedChars = lastPageDwelledRef.current.split('')
    if (carryTimerRef.current) { window.clearTimeout(carryTimerRef.current); carryTimerRef.current = null }
    setCarryMarks(carriedChars)
    if (carriedChars.length) {
      carryTimerRef.current = window.setTimeout(() => setCarryMarks([]), 6000)
    }
    setPageIdx(i => Math.min(i + 1, BOOK.length - 1))
    stageRef.current?.scrollTo?.({ top: 0 })
  }

  function goPrev() {
    if (pageIdx <= 0) return
    clearTimers()
    clearAutoGate()
    autoNudgeRef.current = 0 // 新一页，提醒计数清零
    cancelHold()
    voiceSeqRef.current += 1
    dreamTurnRef.current += 1
    setVoice(null)
    setDreamRespond(null)
    setTraces([])
    setGate('locked')
    setGateReply(null)
    if (carryTimerRef.current) { window.clearTimeout(carryTimerRef.current); carryTimerRef.current = null }
    setCarryMarks([])
    setPageIdx(i => Math.max(i - 1, 0))
    stageRef.current?.scrollTo?.({ top: 0 })
  }

  // ---- 角色对话：你开口，她回应（可选——她一直在旁边说话） ----
  async function sendChat() {
    const text = chatInput.trim()
    if (!text || chatBusy) return
    setChatInput('')
    setChatBusy(true)
    setChatMsgs(prev => [...prev, { role: 'user' as const, text, ts: Date.now() }])
    const dwellHistory = collectDwellHistory(dwellMapRef.current)
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          dwellHistory: dwellHistory.slice(-12),
          recentVoices: recentVoicesRef.current.slice(-4),
          history: chatMsgs.slice(-6).map(m => ({ role: m.role as ChatMsg['role'], text: m.text })),
          // 她的人格在过剧情中慢慢变：传她的成长层、剧情阶段、说过的每一句
          dialog: dialog.slice(-8).map(d => d.voice),
          selfAwareness: selfAwarenessOf(dwellHistory, dialog.length),
          dialogueCount: dialog.length,
          phase: phaseOf(dwellHistory),
        }),
      })
      const data = await resp.json().catch(() => null)
      const reply = (data && typeof data.reply === 'string' && data.reply.trim()) ? data.reply : localChatReply()
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: reply, ts: Date.now() }].slice(-40))
    } catch {
      // 服务没通也绝不冷场：本地回一句人话
      setChatMsgs(prev => [...prev, { role: 'her' as const, text: localChatReply(), ts: Date.now() }].slice(-40))
    } finally {
      setChatBusy(false)
    }
  }

  // ---- 曲终收束：你读出的旋律 + 她问的核心问题 + 后台搜集答案 ----
  function scheduleFinale() {
    if (finaleDoneRef.current) return
    finaleDoneRef.current = true
    window.setTimeout(runFinale, 1800)
  }

  function runFinale() {
    stopMelodyLoop() // 背景让位：安静下来，只剩她说话
    // 结尾只留一张卡片：她开口问这本书最核心的问题
    setFinale({ text: '', carried: '' })
    window.setTimeout(askFinalQuestion, 1400)
  }

  async function askFinalQuestion() {
    const dwellHistory = collectDwellHistory(dwellMapRef.current)
    try {
      const resp = await fetch('/api/final-question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carried: carriedRef.current ? { char: carriedRef.current.char, keptLabel: carriedRef.current.keptLabel } : null,
          dwellHistory: dwellHistory.slice(-12),
          recentVoices: recentVoicesRef.current.slice(-4),
        }),
      })
      const data = await resp.json().catch(() => null)
      const q = (data && typeof data.question === 'string' && data.question.trim()) ? data.question : ''
      setFinaleQuestion(q || LOCAL_FINAL_QUESTIONS[Math.floor(Math.random() * LOCAL_FINAL_QUESTIONS.length)])
    } catch {
      setFinaleQuestion(LOCAL_FINAL_QUESTIONS[Math.floor(Math.random() * LOCAL_FINAL_QUESTIONS.length)])
    }
  }

  function submitFinalAnswer() {
    const answer = finaleAnswer.trim()
    if (!answer) return
    setFinaleAnswered(true)
    const dwellHistory = collectDwellHistory(dwellMapRef.current)
    const record = {
      answer,
      ts: Date.now(),
      carried: carriedRef.current ? { char: carriedRef.current.char, keptLabel: carriedRef.current.keptLabel } : null,
      dwellChars: dwellHistory.map(d => d.char),
      dwellCount: dwellHistory.length,
    }
    try { localStorage.setItem('mudanting:final-answer', JSON.stringify(record)) } catch { /* ignore */ }
    // 后台搜集：静默写入服务端（失败不影响阅读）
    fetch('/api/collect-final-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch(() => {})
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  }

  // 场景随页推进（起/承/转/合）：春朝 → 庭园 → 暮色 → 入梦 → 梦醒
  const page = BOOK[pageIdx]
  const scene = page.scene
  // 落英/墨粒密度随场景变化：春疏 → 庭园盛 → 暮色密 → 入梦稀 → 梦醒无
  const SCENE_PETALS: Record<BookPage['scene'], number> = { spring: 4, garden: 8, dusk: 12, dream: 5, wake: 2 }
  const SCENE_MOTES: Record<BookPage['scene'], number> = { spring: 3, garden: 4, dusk: 5, dream: 6, wake: 2 }
  const petalCount = SCENE_PETALS[scene]
  const moteCount = SCENE_MOTES[scene]

  return (
    <div className={`dream-scene reader-scene reader-scene--${scene} ${finale ? 'dream-scene--finale' : ''}`}>
      {/* 背景：纸面（色温随幕变化）；剧情高潮处（惊梦）才浮现场景画；
          imageOnGrant 页：她给了门，你点一个字替她带走——画面才随她的话浮现 */}
      {page.image && (!page.imageOnGrant || gate === 'granted') && (
        <div key={page.image} className="scene-image" style={{ backgroundImage: `url(${page.image})` }} aria-hidden="true" />
      )}
      <div className="scene-canvas" />
      <div className="ink-pool" />
      <div className="ink-vignette" />
      <PetalField count={petalCount} />
      <MoteField count={moteCount} />

      {/* 顶部 4 控件 */}
      <div className="dream-controls">
        <span className="dream-fs-group">
          <button className="fullscreen" onClick={toggleFullscreen} title="全屏" aria-label="全屏">⛶</button>
          <span className="fs-hint" aria-hidden="true">建议全屏体验</span>
        </span>
        <button onClick={onVernacularToggle} className={vernacularOn ? 'on' : ''} title="今译" aria-label="今译">译</button>
        <button onClick={() => { onSoundToggle(); resumeAudio() }} className={soundOn ? 'on' : ''} title="声音" aria-label="声音">音</button>
        <button onClick={onMotionToggle} className={motionOn ? 'on' : ''} title="动效" aria-label="动效">动</button>
      </div>

      {/* 入场引导卡（第一回保持原样：划过/停驻/翻页 + 昆曲小识） */}
      {introOn && (
        <div className="dream-intro" onClick={() => setIntroOn(false)}>
          <div className="intro-title">《牡丹亭·惊梦》· 两回</div>
          <div className="intro-line">划过 = 读过；停在一个字上，她说一句心里的话</div>
          <div className="intro-line">点一个字，她抬起头与你说话——在左下角可以顺着聊</div>
          <div className="intro-line">读尽一页，她才许你翻过去——但每一幕的过关都不同</div>
          <div className="intro-kunqu">
            <span className="intro-kunqu-tag">昆曲小识</span>
            <p>一折戏唱的是曲牌：〔皂罗袍〕〔好姐姐〕〔山桃红〕——唱词依曲牌而填；划过是过门，停留是板上重音，你停下的地方就是她开口唱的地方。</p>
            <p>每一幕的过关都不同：带走一个字、收她送的字、按住牡丹、在梦里停留；你停过的字会跟着你走，曲终她会停下来，问你压了一路的那句话。</p>
          </div>
          <div className="intro-line intro-line-soft">你若有话，也可以在左下角对她说</div>
        </div>
      )}

      {/* 一页一页读：扫完这一页的字，方可翻下一页 */}
      <main
        ref={stageRef}
        className="reader-stage"
        onPointerMove={onStagePointerMove}
        onPointerLeave={() => { clearTimers(); setVoice(null) }}
      >
        {(() => {
          const page = BOOK[pageIdx]
          const complete = pageCompleteFor(page.id)
          return (
            <div key={page.id} className="reader-page reader-page--in">
              <div className="reader-chapter">
                <span className="reader-chapter-dot" />
                {/* 第一回保留「第X回」；第二回去掉回号——剧情才重要，视觉留给惊梦页 */}
                <span className="reader-chapter-label">
                  {page.chapter === '第二回' ? '' : `${page.chapter} · `}{page.chapterTitle}{page.qupai ? ` ·〔${page.qupai}〕` : ''}
                </span>
              </div>
              {/* 男声（柳生）· 文档流槽位：章节头与正文之间，自然占位不压正文 */}
              {BOOK[pageIdx].dream && (
                <div
                  className={`dream-respond dream-respond--slot ${dreamRespond ? 'dream-respond--show' : ''}`}
                  aria-hidden={!dreamRespond}
                >
                  {dreamRespond && (
                    <>
                      <span className="dream-respond-text">{dreamRespond.text}</span>
                      <span className="dream-respond-relation">— {dreamRespond.relation}</span>
                    </>
                  )}
                </div>
              )}
              {page.epigraph && <p className="reader-epigraph">{page.epigraph}</p>}
              {page.lines.map((line, li) => {
                // 读完整句，今译才浮现（学进去：读一句，译一句）
                const lineComplete = line.split('').every((ch, ci) => PUNCT.test(ch) || readSetRef.current.has(keyOf(page.id, li, ci)))
                return (
                  <div key={`${page.id}-${li}`} className="reader-line-block">
                    <div className="reader-line">
                      {line.split('').map((ch, ci) => {
                        const key = keyOf(page.id, li, ci)
                        const read = readSetRef.current.has(key)
                        const isDwelled = traces.some(t => t.key === key)
                        return (
                          <span
                            key={ci}
                            className={`rchar ${read ? 'rchar--read' : ''} ${isDwelled ? 'rchar--dwelled' : ''} ${holdingKey === key ? 'rchar--holding' : ''}`}
                            style={holdingKey === key ? ({ '--hold-ms': `${GATE_TASKS[page.id]?.holdMs || 1600}ms` } as React.CSSProperties) : undefined}
                            onPointerEnter={(e) => onCharEnter(page.id, li, ci, e)}
                            onPointerLeave={() => { onCharLeave(page.id, li, ci); cancelHold() }}
                            onPointerDown={() => startHold(page.id, li, ci, ch)}
                            onPointerUp={cancelHold}
                            onClick={(e) => handleCharClick(page.id, li, ci, e)}
                          >{ch}</span>
                        )
                      })}
                    </div>
                    {vernacularOn && lineComplete && page.vernacularLines[li] && (
                      <div className="reader-line-vernacular">
                        <span className="vernacular-label">今译</span>
                        {page.vernacularLines[li]}
                      </div>
                    )}
                  </div>
                )
              })}
              {/* 女声（杜丽娘）· 文档流槽位：正文与过关提示之间，自然占位不压正文 */}
              {BOOK[pageIdx].dream && (
                <div
                  className={`inner-voice inner-voice--slot ${voice ? 'inner-voice--show' : ''} ${voice?.level === 2 ? 'inner-voice--l2' : ''}`}
                  aria-hidden={!voice}
                >
                  {voice && (
                    <>
                      <span className="inner-voice-char">「{voice.char}」</span>
                      <span className="inner-voice-text">{voice.text}</span>
                    </>
                  )}
                </div>
              )}
              {page.note && (
                <div className="reader-note">
                  <span className="reader-note-label">她留在此页的话</span>
                  <span className="reader-note-text">{page.note}</span>
                </div>
              )}
              {/* 她把门：她给一个任务，你在这一页的原文里点一个字给她 */}
              {complete && gateAsk && (gate === 'asking' || gate === 'granted') && (
                <div className="reader-gate">
                  <p className="gate-question">
                    <span className="gate-label">她说</span>
                    {gateAsk}
                  </p>
                  {gate === 'granted' && gateReply ? (
                    <p className="gate-reply">
                      <span className="gate-label">她应道</span>
                      {gateReply}
                    </p>
                  ) : (
                    <p className="gate-hint">
                      <span className="gate-label">行动</span>
                      {gateHint}
                    </p>
                  )}
                </div>
              )}
                            {/* 翻页门槛：读尽此页 + 她应允，方可续行 */}
              <div className="reader-turn">
                {pageIdx > 0 && (
                  <button className="reader-turn-btn reader-turn-btn--prev" onClick={goPrev} title="上一页" aria-label="上一页">‹</button>
                )}
                {pageIdx < BOOK.length - 1 && (
                  <button
                    className={`reader-turn-btn ${complete && gate === 'granted' ? 'reader-turn-btn--ready' : ''}`}
                    onClick={goNext}
                    disabled={!complete || gate !== 'granted'}
                    title={!complete ? '把这一页的字都划过，她才许你往下走' : gate === 'speaking' ? '她正有话要对你说' : gate === 'asking' ? '答她一句，她才许你过去' : '她应允了，随她往下一幕去'}
                    aria-label="下一页"
                  >
                    {!complete ? '读尽此页，方可续行'
                      : gate === 'speaking' ? '她要开口了…'
                      : gate === 'asking' ? (GATE_TASKS[page.id]?.mode === 'hold' ? '按住那朵牡丹，方可续行'
                          : GATE_TASKS[page.id]?.mode === 'dwell' ? '在梦里再停一处'
                          : GATE_TASKS[page.id]?.mode === 'gift' ? '收下她送你的字，方可续行'
                          : GATE_TASKS[page.id]?.mode === 'tradeoff' ? '带走一个字，方可续行'
                          : '答她一句，方可续行')
                      : '她应允了 · 随她往深处走'}
                  </button>
                )}
              </div>
            </div>
          )
        })()}
      </main>

      {/* 相识簿：她记住的字与话（右下，常驻；相会页单独设计——那页是上下对话，女声只落字下，右侧不回答） */}
      {!page.dream && (
        <div className="dialog-book" aria-hidden="true">
          {dialog.length > 0 ? (
            <div className="dialog-book-head">她对你说过 <strong>{dialog.length}</strong> 句</div>
          ) : (
            <div className="dialog-empty">她等着你停下的第一个字</div>
          )}
          {dialog.slice(-4).map(e => (
            <div key={e.ts} className={`dialog-entry ${e.milestone ? 'dialog-entry--milestone' : ''} ${e.gift ? 'dialog-entry--gift' : ''}`}>
              <span className="dialog-entry-char">「{e.char}」</span>
              {e.gift && <span className="dialog-entry-gift">她送你的</span>}
              {e.qupaiLabel && <span className="dialog-entry-qupai">{e.qupaiLabel}</span>}
              <span className="dialog-entry-voice">{e.voice}</span>
            </div>
          ))}
        </div>
      )}

      {/* 左下读书卡片：她在旁看你读书，说给你听（也可对她说一句） */}
      <div className="dream-chat">
        <div className="dream-chat-head"><span className="dream-chat-dot" />她在旁看你读书</div>
        <div className="dream-chat-msgs">
          {chatMsgs.length === 0 && (
            <div className="chat-empty">划过、停驻、翻页——她都会在旁边说话。</div>
          )}
          {chatMsgs.map(m => (
            <div key={m.ts} className={`chat-msg chat-msg--${m.role}`}>
              <span className="chat-msg-name">{m.role === 'her' ? '她' : '你'}</span>
              <span className="chat-msg-text">{m.text}</span>
            </div>
          ))}
          {chatBusy && <div className="chat-typing">她正要开口……</div>}
        </div>
        <div className="dream-chat-input">
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendChat() }}
            placeholder="你也可以对她说一句…"
            aria-label="与杜丽娘说话"
            maxLength={60}
          />
          <button onClick={sendChat} disabled={chatBusy || !chatInput.trim()} aria-label="说">说</button>
        </div>
      </div>

      {/* 痕迹层：停过的字，胭脂墨渍（数秒后淡出） */}
      {motionOn && (
        <div className="trace-layer" aria-hidden="true">
          {traces.map(t => (
            <span key={`${t.key}-${t.ts}`} className={`trace-mark trace-mark--${t.bias}`} style={{ left: t.x, top: t.y + 28 }} />
          ))}
        </div>
      )}

      {/* 涟漪层 */}
      {motionOn && (
        <div className="ripple-layer" aria-hidden="true">
          {ripples.map(r => (
            <span key={r.id} className="ripple" style={{ left: r.x, top: r.y, opacity: 0.85 * r.strength }} />
          ))}
        </div>
      )}

      {/* 衔字：上一页你停过的字，跟着你走到这一页的纸角 */}
      {motionOn && carryMarks.length > 0 && (
        <div className="carry-marks" aria-hidden="true">
          {carryMarks.map((c, i) => <span key={i} className="carry-mark">{c}</span>)}
        </div>
      )}

      {/* 曲终一问：她只留下一张卡片，问你压了一路的话 */}
      {finale && finaleQuestion && (
        <div className="finale-question">
          <p className="fq-mark">她同你说</p>
          <p className="fq-question">{finaleQuestion}</p>
          {finaleAnswered ? (
            <p className="fq-done">她听见了。你答的话，会跟着这一梦，一起收好。</p>
          ) : (
            <>
              <input
                className="fq-input"
                value={finaleAnswer}
                maxLength={140}
                onChange={e => setFinaleAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitFinalAnswer() }}
                placeholder="你若愿意，答她一句…"
                aria-label="答她一句"
              />
              <div className="fq-actions">
                <button className="fq-submit" onClick={submitFinalAnswer} disabled={!finaleAnswer.trim()}>说与她听</button>
              </div>
            </>
          )}
        </div>
      )}
      {finale && (
        <button className="final-close" onClick={onReenter} aria-label="回到原文再读一遍">
          <span className="final-close-main">回到原文再读一遍</span>
          <span className="final-close-sub">梦会醒，园会谢——但有人记得读过</span>
        </button>
      )}
    </div>
  )
}

function MoteField({ count }: { count: number }) {
  const motes = useMemoMotes(count)
  return (
    <div className="motes" aria-hidden="true">
      {motes.map(m => (
        <span key={m.id} className="mote" style={{
          left: `${m.left}%`, bottom: -10, width: m.size, height: m.size,
          ['--mote-duration' as string]: `${m.duration}s`,
          ['--mote-delay' as string]: `${m.delay}s`,
          ['--mote-drift' as string]: `${m.drift}px`,
          ['--mote-opacity' as string]: String(m.opacity),
        }} />
      ))}
    </div>
  )
}

/* 杜丽娘 · 头部心象：已随方向调整移除（保留相识簿/心声/对话等核心交互） */
function PetalField({ count }: { count: number }) {
  const petals = useMemoPetals(count)
  return (
    <div className="petal-layer" aria-hidden="true">
      {petals.map(p => (
        <span key={p.id} className="petal" style={{
          left: `${p.left}%`, top: -20, width: p.size, height: p.size * 1.4,
          ['--petal-duration' as string]: `${p.duration}s`,
          ['--petal-delay' as string]: `${p.delay}s`,
          ['--petal-drift' as string]: `${p.drift}px`,
          ['--petal-rotate' as string]: `${p.rotate}deg`,
          ['--petal-opacity' as string]: String(p.opacity),
        }} />
      ))}
    </div>
  )
}

function useMemoMotes(count: number) {
  // 随场景数量变化重新生成（背景切换时密度随之改变）
  return useMemo(() => Array.from({ length: count }, (_, i) => ({
    id: i, left: Math.random() * 100,
    size: 2 + Math.random() * 3,
    duration: 22 + Math.random() * 14,
    delay: -Math.random() * 24,
    drift: (Math.random() - 0.5) * 30,
    opacity: 0.18 + Math.random() * 0.32,
  })), [count])
}

function useMemoPetals(count: number) {
  // 随场景数量变化重新生成（背景切换时密度随之改变）
  return useMemo(() => Array.from({ length: count }, (_, i) => ({
    id: i, left: Math.random() * 100,
    duration: 16 + Math.random() * 12,
    delay: -Math.random() * 18,
    drift: (Math.random() - 0.5) * 160,
    rotate: Math.random() * 360,
    opacity: 0.28 + Math.random() * 0.32,
    size: 5 + Math.random() * 5,
  })), [count])
}
