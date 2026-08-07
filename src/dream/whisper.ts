/**
 * 余韵召回客户端
 * 失败/超时静默——读者视野里什么都不显示，符合"在场的意识"定位。
 */

import type { EchoCandidate, WhisperResult } from './types'

export async function callWhisper(
  anchorText: string,
  lineId: string,
  candidates: EchoCandidate[],
  signal?: AbortSignal,
): Promise<WhisperResult | null> {
  if (!anchorText || !candidates.length) return null
  try {
    const resp = await fetch('/api/whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anchorText,
        lineId,
        scene: 'garden',
        candidates: candidates.map(c => ({ id: c.id, targetText: c.targetText, relation: c.relation })),
      }),
      signal,
    })
    if (!resp.ok) return null
    const data = await resp.json() as { ok: boolean; source?: string; echoId?: string | null; relation?: string; confidence?: number }
    if (!data.ok || !data.echoId) return null
    // 二次校验：echoId 必须在候选池中
    if (!candidates.find(c => c.id === data.echoId)) return null
    return { echoId: data.echoId, relation: data.relation || '缘', confidence: data.confidence || 0 }
  } catch {
    return null
  }
}
