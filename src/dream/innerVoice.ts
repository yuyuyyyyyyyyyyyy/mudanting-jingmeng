/**
 * 杜丽娘心声客户端
 * 失败/超时/质量不合格——回到预设 fallback
 */

export interface InnerVoiceResult {
  voice: string
  phase: '惊叹' | '疑问' | '铺陈' | '痛悟' | string
  source: 'deepseek' | 'local'
  basedOn?: string   // Agent·Plan：这一句主要回应读者停过的哪个字
}

// 读者停留路径证据（Observe → State 的输入）
export interface DwellEvidence {
  dwellPath: { char: string; bias: string; lineId: string }[]
  scores: { spring: number; ruin: number; self: number }
}

// basedOn 安全校验：必须是单个非标点、非空白、非问号的字符
const PUNCT_SAFE = /[\u3000-\u303F\uff00-\uffef\u2000-\u206f，。、！？；：""''「」\s\?？]/

// 本地兜底：每个字一句人话（人工撰写，不依赖 AI）
const LOCAL_FALLBACK: Record<string, string> = {
  原: '原来姹紫嫣红，都是真的。',
  来: '来了一趟，才知从前是关着的。',
  姹: '我从未见过这样的颜色。',
  紫: '原是这般紫。',
  嫣: '像是它自己在笑。',
  红: '红到不像是真的。',
  开: '满园子都开了。',
  遍: '开遍了，也开尽了我的从前。',
  似: '似这般，原是命里有的。',
  这: '这般好景，怎么不早一日。',
  般: '好到这般地步。',
  都: '都付与了荒凉。',
  付: '付出去的是颜色，留下来的是空。',
  与: '与我对望的，是这颓垣。',
  断: '美到这般，都付与荒凉。',
  井: '井边也长出花来了。',
  颓: '颓垣上的颜色，倒比院里的更烈。',
  垣: '垣墙隔得开我，隔不开这一园春色。',
  良: '这般好时辰。',
  辰: '这样的时辰，竟让我赶上了。',
  美: '美到心发疼。',
  景: '一辈子就这一次景。',
  奈: '天若能奈，便不会让我等到今天。',
  何: '何其晚也。',
  天: '天若有情。',
  赏: '我若能赏，便不只是看看。',
  心: '心在这里，人却不在这里。',
  乐: '乐到要落泪。',
  事: '这样的事，怎么就落在我身上。',
  谁: '这是谁家的春天。',
  家: '家？我哪里有过园子。',
  院: '院里这些，是我的，又不是我的。',
  朝: '朝来暮往，都付与这园子。',
  飞: '飞起来的不只是云。',
  暮: '暮色也染上我的衣了。',
  卷: '卷起的是帘，卷不起的是心。',
  云: '云是不等人的。',
  霞: '霞光像一匹绸。',
  翠: '翠色入眼，便入了心。',
  轩: '轩窗不曾为我开过。',
  雨: '雨一来，春色便更湿。',
  丝: '雨丝像一根一根的。',
  风: '风在替我哭。',
  片: '风过处，片片都是春。',
  烟: '烟里看不清自己。',
  波: '烟波上有船，船上无人。',
  画: '画里画外，都是我。',
  船: '船载得动春，载不动我。',
  锦: '锦屏内外，判若两人。',
  屏: '这屏风关了我十六年。',
  人: '我何时才能像个人那样活。',
  忒: '忒煞是看轻了。',
  看: '看花时，才看见自己。',
  韶: '韶光一寸也不等人。',
  光: '这光，照得到花，照不到我。',
  贱: '我把春天看贱了，春天也把我看贱了。',
}

/**
 * 客户端质量校验：必须有"人话"特征
 *
 * 拒掉的典型坏输出：
 *   "紫姹原井美"          —— 单字堆砌，无虚词/标点
 *   "ABC 啊啊啊"          —— 英文 + 语气词
 *   "原来"                —— 太短
 *   "一二三"              —— 无意义连续
 */
function passesQuality(s: string, maxLen: number = 24): boolean {
  if (!s) return false
  const t = s.replace(/\s/g, '')
  if (t.length < 5 || t.length > maxLen) return false

  // 必须以汉字开头、汉字结尾（不要以标点/引号开头）
  const first = t[0]
  const last = t[t.length - 1]
  if (!/[一-鿿]/.test(first) || !/[一-鿿。，！？]/.test(last)) return false

  // CJK 比例
  const cjkCount = (t.match(/[一-鿿]/g) || []).length
  if (cjkCount / t.length < 0.8) return false
  if (cjkCount < 5) return false

  // 拒连续标点
  if (/[，。、！？；：""''「」]{2,}/.test(t)) return false

  // 拒连续英文 / 数字
  if (/[a-zA-Z]{3,}/.test(t)) return false
  if (/\d{3,}/.test(t)) return false

  // ★ 核心：必须有"虚词"或"句末标点"，否则就是字串堆砌
  const hasFunctionWord = /[的了是有也在就不把会被给与同或而却虽但要会能可来去到这那谁何怎奈忒赏]/.test(t)
  const hasEndingPunct = /[。！？]/.test(t)
  if (!hasFunctionWord && !hasEndingPunct) return false

  // 拒"两个相邻字都不带笔画连带"的随机字串（粗略启发式）
  // 例如"紫姹原井美"——连用生僻字 + 没有句末标点
  const rareCount = (t.match(/[姹嫣颓垣忒韶]/) || []).length
  if (rareCount >= 3 && !hasEndingPunct) return false

  return true
}

// 兜底句池：本地没有这个字的专属话时，按字散开（避免不同字都回同一句"原来姹紫嫣红开遍"）
const GENERIC_FALLBACKS = [
  '原来姹紫嫣红开遍。',
  '这般颜色，只在这一眼里。',
  '十六年的门，今朝开了一条缝。',
  '园子比书里写的还要好。',
  '这样的时辰，竟让我遇上了。',
]

/**
 * 归一化：去掉标点空白，用于比对是否重复
 */
function normalizeVoice(s: string): string {
  return s.replace(/[\s，。、！？；：""''「」…·]/g, '')
}

/**
 * 新颖度校验：与最近说过的话太像，视为重复
 *  - 归一化后完全一致 → 重复
 *  - 开头 4 字相同（同一模板开场，如"这满园春色…""这满园颜色…"）→ 重复
 *  - 与最近两句共享去重后字符超过 60% → 重复（防"换几个字重写同一句"）
 */
function isRepetitive(voice: string, recent: string[]): boolean {
  const v = normalizeVoice(voice)
  if (!v) return true
  for (const prev of recent.slice(-2)) {
    const p = normalizeVoice(prev)
    if (!p) continue
    if (v === p) return true
    if (v.length >= 4 && p.length >= 4 && v.slice(0, 4) === p.slice(0, 4)) return true
    const vc = new Set(v)
    const shared = [...vc].filter(c => p.includes(c)).length
    if (shared / vc.size > 0.6) return true
  }
  return false
}

/**
 * 对话模式要的是"一段话"：她抬起头同你说话
 *  - 34 字以上（去掉标点）必然是一段话
 *  - 或 28 字以上且至少两个分句（有逗号/分号/句号）——说出口的话，不是单句短句
 */
function isDialogueParagraph(voice: string): boolean {
  const n = normalizeVoice(voice)
  if (n.length >= 34) return true
  const separators = (voice.match(/[，、；。]/g) || []).length
  return n.length >= 28 && separators >= 2
}

/**
 * 对话模式的本地兜底：她抬起头同你说话，应是一段话（不是右侧短句簿里那种短句）
 *  - 用字对应的短句做引子 + 按字散开的开头与收尾，避免每句都一个模子
 */
const DIALOGUE_FRAMES = [
  (ch: string) => `你点出这个「${ch}」字来，倒让我心里一动。`,
  (ch: string) => `你偏偏停在「${ch}」上，像是看穿了我。`,
  (ch: string) => `「${ch}」……你竟同我说这个字。`,
]
const DIALOGUE_TAILS = [
  '这一园子的心事，我原只想自己藏着；你既看出来了，我便同你说一说。',
  '这话我原只敢在心里过一遍；你问起，我反倒说得出口了。',
  '我活了十六年，头一回有人陪我看园子——便同你说了罢。',
]
let dialogueTurn = 0
function dialogueFallback(ch: string, shortLine: string): string {
  // 轮换开头与收尾，连续说几段话也不重样
  const frame = DIALOGUE_FRAMES[dialogueTurn % DIALOGUE_FRAMES.length](ch)
  const tail = DIALOGUE_TAILS[(dialogueTurn >> 1) % DIALOGUE_TAILS.length]
  dialogueTurn += 1
  return `${frame}${shortLine}${tail}`
}

export async function callInnerVoice(input: {
  char: string
  lineId: string
  lineText: string
  phase: string
  dwellMs: number
  recentVoices: string[]
  evidence: DwellEvidence
  dwellLevel?: 1 | 2     // 停留深度：1 初触 / 2 深驻（停留越久，她的话越深）
  milestone?: boolean    // 阶段回望：每攒满 3 个字，她拢起一路说过的话
  dialogue?: boolean     // 点击 = 对话：她抬起头与你说话（进左下卡片），非停留短句
}): Promise<InnerVoiceResult | null> {
  // 本地兜底：停留短句用这个字的专属话；点击对话用一段话（左边是她抬头同你说话）
  const shortLine = LOCAL_FALLBACK[input.char]
    || GENERIC_FALLBACKS[input.char.charCodeAt(0) % GENERIC_FALLBACKS.length]
  const localFallback = input.dialogue
    ? dialogueFallback(input.char, shortLine)
    : shortLine
  const payload = {
    ...input,
    dwellLevel: input.dwellLevel || 1,
  }
  try {
    const resp = await fetch('/api/inner-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) return { voice: localFallback, phase: input.phase, source: 'local', basedOn: input.char }
    const data = (await resp.json()) as { ok: boolean; voice?: string; phase?: string; source?: string; basedOn?: string }
    if (!data.voice) return { voice: localFallback, phase: input.phase, source: 'local', basedOn: input.char }
    // 客户端质量校验：AI 返回的若不通顺，自动用本地
    // 对话模式是一段话（40-60 字 + 标点），放长到 72 字
    if (!passesQuality(data.voice, input.dialogue ? 72 : 24)) {
      return { voice: localFallback, phase: input.phase, source: 'local', basedOn: input.char }
    }
    // 新颖度校验：与最近说过的话太像 → 退回本地（防止她反复说同一句"春色为我开"）
    if (isRepetitive(data.voice, input.recentVoices)) {
      return { voice: localFallback, phase: input.phase, source: 'local', basedOn: input.char }
    }
    // 对话模式：她抬起头同你说话，应是一段话（≥30 字）——太短（单句短句）就补成一段话
    if (input.dialogue && !isDialogueParagraph(data.voice)) {
      return { voice: localFallback, phase: input.phase, source: 'local', basedOn: input.char }
    }
    // Agent·Act 校验：basedOn 必须在读者路径或当前字中；并且必须是单个合法汉字/字符，否则退回当前字
    const validChars = new Set(input.evidence.dwellPath.map(d => d.char))
    validChars.add(input.char)
    let basedOn = data.basedOn && validChars.has(data.basedOn) ? data.basedOn : input.char
    // 额外防御：空值/问号/多字符/空白符一律退回当前字（防 basedOn:"?" 这种服务端路径漏校验）
    if (!basedOn || basedOn.length !== 1 || basedOn === '?' || /\s/.test(basedOn) || PUNCT_SAFE.test(basedOn)) {
      basedOn = input.char
    }
    return {
      voice: data.voice,
      phase: data.phase || input.phase,
      source: (data.source as 'deepseek' | 'local') || 'local',
      basedOn,
    }
  } catch {
    return { voice: localFallback, phase: input.phase, source: 'local', basedOn: input.char }
  }
}
