// 内容数据结构 —— 与 public/data/chapter10.json 对应
export interface Segment {
  speaker: string
  text: string
  stageHint?: string   // 舞台提示（原文括号内容）
  inner?: boolean      // 内心独白
  aside?: boolean      // 夹白
}

export interface Gloss {
  word: string
  meaning: string
}

export type SectionType = 'aria' | 'dialogue' | 'soliloquy' | 'stage'
export type StageMode = 'reality' | 'dream' | 'wake'

export interface Section {
  id: string
  type: SectionType
  tune: string | null
  stage: StageMode
  revealStyle: 'ink' | 'direct' | 'zaolaopao'
  motifs?: string[]
  segments: Segment[]
  glosses: Gloss[]
  vernacular?: string // 今译，非原文，默认隐藏
}

export interface Whisper {
  id: string
  text: string
  startAfter: string
  when?: 'hasStart' // 条件低语：仅当读者已设过「开始」
}

export type RelationType = '回应' | '加深' | '反转' | '兑现' | '对照' | '误读'

export interface Echo {
  id: string
  sourceSectionId: string
  sourceText: string
  targetSectionId: string
  targetText: string
  relation: RelationType
  questions: string[]
  earliestAt: string
  explanation: string
  confidence: 'high' | 'medium' | 'low'
  reviewed: boolean
}

export interface Chapter {
  chapterId: string
  chapterTitle: string
  source: string
  demoSectionIds: string[]
  sections: Section[]
  whispers: Whisper[]
  echoes: Echo[]
}

// —— 阅读产生的数据（localStorage） ——
export interface Underline {
  id: string
  questionId: string | null
  sectionId: string
  text: string
  startOffset: number   // 在该 section 纯文本中的偏移
  endOffset: number
  createdAt: number
  readingPosition: string
  boundEchoIds: string[] // 由 findReviewedEchoes 绑定
  inferenceSource?: 'deepseek' | 'local'
  inferenceConfidence?: number
}

/** 书签槽：读者认定的「一切开始的那一句」。旧句沉入痕迹（active=false）。 */
export interface StartMark {
  id: string
  sectionId: string
  text: string
  createdAt: number
  active: boolean
}

export interface Annotation {
  id: string
  text: string
  createdAt: number
}

export interface Settings {
  sound: boolean      // 默认关
  motion: boolean     // 默认开
  demoMode: boolean   // 默认演示节选
  vernacular: boolean // 今译对照，默认关
}

export interface Progress {
  maxRevealed: number
  finished: boolean
}

export interface CatalogEntry {
  id: string
  title: string
  status: 'ready' | 'pending'
}

export interface Catalog {
  playTitle: string
  author: string
  totalChapters: number
  note: string
  chapters: CatalogEntry[]
}

// —— AI 调度演出：读者注意力状态（隐形，不向用户展示） ——
export type AttentionMotif =
  | 'sound' | 'self' | 'spring' | 'threshold'
  | 'ruin' | 'dream' | 'time' | 'desire'

export interface AttentionChoice {
  beatId: string
  optionId: string
  motifs: AttentionMotif[]
  createdAt: number
}

export interface AttentionState {
  weights: Record<AttentionMotif, number>
  recentChoices: AttentionChoice[]
  dominantMotifs: AttentionMotif[]
}

// —— 人工审核的演出候选：DeepSeek 只能返回其中的 id ——
export type VisualCue =
  | 'window_light' | 'mirror_focus' | 'gate_open'
  | 'bloom_expand' | 'ruin_reveal' | 'dream_haze'
  | 'baseline'

export type SoundCue =
  | 'bird_distant' | 'room_hush' | 'strings_rise'
  | 'strings_thin' | 'silence_cut' | 'baseline'

export type Pace = 'flow' | 'hold' | 'linger'

export interface StagingCandidate {
  id: string
  beatId: string
  motifs: AttentionMotif[]
  visualCue: VisualCue
  soundCue: SoundCue
  pace: Pace
  echoId?: string
  priority: number // 人工优先级，同分时使用
  reviewed: true
}

/** 选项入口：点击后只更新注意力权重并推进，不显示解释。 */
export interface AttentionOption {
  id: string
  label: string          // 注意力对象，非解释：莺声 / 庭院中的她 / 园门 …
  motifs: AttentionMotif[]
  /** 选择后立即落地的极短调度提示（非评论），可为空，靠画面声音表达 */
  stagingHint?: string
}

export interface StagingBeat {
  beatId: string          // 形如 "10-01#0"（sectionId#segmentIndex）
  sectionId: string
  segmentIndex: number
  options: AttentionOption[]
  /** 是否在到达此 beat 时调用 /api/stage 进行分流兑现 */
  resolve?: boolean
}

export interface StagingResolution {
  candidateId: string
  candidate: StagingCandidate
  confidence: number
  dominantMotifs: AttentionMotif[]
  source: 'deepseek' | 'local'
}
