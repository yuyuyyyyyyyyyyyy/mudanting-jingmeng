/**
 * 阅读偏向 Agent —— 单例，负责"首次进入 10-08#0 时冻结一次"的一次性逻辑。
 *
 * - decide(state): 首次调用计算并保存；后续调用直接返回已保存结果
 * - getResult(): 取已保存结果（未决策返回 null）
 * - reset(): 清除结果（章节重置时调用）
 *
 * 决策本身在 reading-bias.ts 的纯函数里，可独立测试。
 */
import { deriveReadingBias, type ReadingBiasResult } from './reading-bias'
import type { Persisted } from './store'

class ReadingBiasAgent {
  private result: ReadingBiasResult | null = null

  /** 首次调用冻结；之后不重算 */
  decide(state: Persisted): ReadingBiasResult {
    if (this.result) return this.result
    this.result = deriveReadingBias(state)
    return this.result
  }

  getResult(): ReadingBiasResult | null {
    return this.result
  }

  reset(): void {
    this.result = null
  }
}

let agent: ReadingBiasAgent | null = null
export function getReadingBiasAgent(): ReadingBiasAgent {
  if (!agent) agent = new ReadingBiasAgent()
  return agent
}
export function resetReadingBiasAgent(): void {
  agent = null
}
