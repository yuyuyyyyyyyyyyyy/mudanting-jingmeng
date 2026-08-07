/**
 * 司梦人低语客户端
 * 调用 /api/dream-whisper（旧版就有），由司梦人返回 30 字内的昆曲化短句。
 * 失败/超时静默——读者视野里什么都不显示。
 */

export interface DreamWhisperResult {
  whisper: string
  tone: 'observe' | 'echo' | 'hold' | 'shift'
  source: 'deepseek' | 'local'
}

export async function callDreamWhisper(input: {
  phaseId: string
  phaseLabel: string
  beatText: string
  readerAction: string
  choiceLabel: string
  pauseMs: number
  recentWhispers: string[]
}): Promise<DreamWhisperResult | null> {
  try {
    const resp = await fetch('/api/dream-whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!resp.ok) return null
    const data = await resp.json() as { ok: boolean; whisper?: string; tone?: string; source?: string }
    if (!data.ok || !data.whisper) return null
    const tone = (['observe', 'echo', 'hold', 'shift'] as const).includes(data.tone as never)
      ? (data.tone as DreamWhisperResult['tone'])
      : 'observe'
    return { whisper: data.whisper, tone, source: (data.source as 'deepseek' | 'local') || 'local' }
  } catch {
    return null
  }
}
