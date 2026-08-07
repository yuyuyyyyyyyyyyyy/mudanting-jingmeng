/**
 * 司梦 Agent —— 两个 AI 调用的前端封装
 * AI 负责理解和判断，代码（dream-law.ts）负责守法。
 * 失败时返回 null，调用方走本地兜底。
 */
import type { DreamMemory, DramaWindow, CompatibilityAssessment } from './dream-law'

export async function deriveMemoryEvidence(rawText: string): Promise<DreamMemory | null> {
  try {
    const res = await fetch('/api/dream-evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText: rawText.slice(0, 200) }),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.ok || !data.memory) return null
    return data.memory as DreamMemory
  } catch {
    return null
  }
}

export async function assessCompatibility(
  memory: DreamMemory,
  window: DramaWindow,
): Promise<CompatibilityAssessment | null> {
  try {
    const res = await fetch('/api/dream-assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory, window }),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.ok || !data.assessment) return null
    return data.assessment as CompatibilityAssessment
  } catch {
    return null
  }
}
