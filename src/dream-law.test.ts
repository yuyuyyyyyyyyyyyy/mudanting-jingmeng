import { describe, it, expect } from 'vitest'
import {
  type DreamMemory, type DreamState, type CompatibilityAssessment,
  applyDreamLaw, applyResponseToState, advanceState, initialDreamState,
  validateMemoryEvidence, WINDOWS,
} from './dream-law'

const memoryA: DreamMemory = {
  rawText: '外婆以前在院子里晒被子，后来房子拆掉了。',
  evidence: [
    { id: 'e1', text: '外婆',         start: 0,  end: 2,  kind: 'person' },
    { id: 'e2', text: '院子',         start: 5,  end: 7,  kind: 'place' },
    { id: 'e3', text: '晒被子',       start: 8,  end: 11, kind: 'action' },
    { id: 'e4', text: '房子拆掉了',   start: 14, end: 19, kind: 'event' },
  ],
  affordances: [
    { id: 'a1',  value: '布面随风极轻摩擦声',         layer: 'sound',  depth: 'mirror', derivedFrom: ['e3'], transformation: '晾晒→声音(一瞬)' },
    { id: 'a1m', value: '布面摩擦声持续，与风声叠',   layer: 'sound',  depth: 'merge',  derivedFrom: ['e3'], transformation: '晾晒→声音(一段)' },
    { id: 'a2',  value: '远处短暂晾晒动作轮廓',       layer: 'action', depth: 'mirror', derivedFrom: ['e3'], transformation: '晾晒→动作(一瞬)' },
    { id: 'a2m', value: '园中风吹花木与布面随风重合', layer: 'scene',  depth: 'merge',  derivedFrom: ['e3'], transformation: '晾晒→景物叠合' },
    { id: 'a3e', value: '房屋轮廓成为梦境空间并消退', layer: 'scene',  depth: 'enter',  derivedFrom: ['e4'], transformation: '拆除→轮廓消失(入梦)' },
  ],
  forbiddenExamples: ['死亡', '离别', '无人回应'],
}

const memoryB: DreamMemory = {
  rawText: '一封一直没有发出的辞职信。',
  evidence: [
    { id: 'e1', text: '辞职信',       start: 9,  end: 12, kind: 'object' },
    { id: 'e2', text: '一直没有发出', start: 2,  end: 8,  kind: 'action' },
  ],
  affordances: [
    { id: 'b1',  value: '纸张轻响',                   layer: 'sound',  depth: 'mirror', derivedFrom: ['e1'], transformation: '信→纸声' },
    { id: 'b1m', value: '纸张声持续未停',             layer: 'sound',  depth: 'merge',  derivedFrom: ['e1'], transformation: '信→纸声(持续)' },
    { id: 'b2',  value: '递交动作停顿',               layer: 'action', depth: 'mirror', derivedFrom: ['e2'], transformation: '未发出→停顿' },
    { id: 'b2m', value: '一页未被递出的文字(不展示内容)', layer: 'action', depth: 'merge',  derivedFrom: ['e2'], transformation: '未发出→文字物' },
  ],
  forbiddenExamples: ['压抑', '后悔', '没说出口的话'],
}

function makeAssessment(perAffordance: CompatibilityAssessment['perAffordance']): CompatibilityAssessment {
  return { perAffordance, originalConflict: 'low', characterIntrusionRisk: 'low', reasons: [] }
}

describe('司梦法则', () => {

  // 1. 沉默时不得从 merge 升级到 enter
  it('沉默时不得从 merge 升级到 enter', () => {
    const state: DreamState = { ...initialDreamState(), currentDepth: 'merge', entryConsent: 'granted' }
    const assessment = makeAssessment([
      { affordanceId: 'a3e', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'strong', actionBridge: 'strong', allowedLayers: ['scene'], evidenceIds: ['e4'], reason: '可入景物' },
      { affordanceId: 'a2m', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'weak', actionBridge: 'strong', allowedLayers: ['scene'], evidenceIds: ['e3'], reason: '景物可叠合' },
    ])
    const d = applyDreamLaw(memoryA, WINDOWS.dream_enter, state, { kind: 'silence' }, assessment)
    expect(d.kind === 'present' && d.depth).toBe('merge')
    if (d.kind === 'present') {
      expect(d.layers.some(l => l.affordanceId === 'a3e')).toBe(false)
      expect(d.layers.some(l => l.affordanceId === 'a2m')).toBe(true)
    }
  })

  // 2. affirm 许可持续到下一窗口
  it('先前 affirm 的许可在下一窗口仍有效', () => {
    let state = initialDreamState()
    state = applyResponseToState(state, { kind: 'affirm', rawText: '愿意' })
    expect(state.entryConsent).toBe('granted')
    const assessment = makeAssessment([
      { affordanceId: 'a3e', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'strong', actionBridge: 'strong', allowedLayers: ['scene'], evidenceIds: ['e4'], reason: '可入景物' },
    ])
    const d = applyDreamLaw(memoryA, WINDOWS.dream_enter, state, { kind: 'none' }, assessment)
    expect(d.kind === 'present' && d.depth).toBe('enter')
  })

  // 3. 一项转译越界不应拒绝其他合法转译
  it('一项转译越界不应拒绝其他合法转译', () => {
    const assessment = makeAssessment([
      { affordanceId: 'b1', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'none', actionBridge: 'none', allowedLayers: ['sound'], evidenceIds: ['e1'], reason: '纸声可共存' },
      { affordanceId: 'b2', grounding: 'requires_invention', sensoryBridge: 'none', spatialBridge: 'none', actionBridge: 'none', allowedLayers: [], evidenceIds: ['e2'], reason: '需补造内容' },
    ])
    const state = initialDreamState()
    const d = applyDreamLaw(memoryB, WINDOWS.boundary_soft, state, { kind: 'none' }, assessment)
    expect(d.kind === 'present' && d.layers.some(l => l.affordanceId === 'b1')).toBe(true)
    expect(d.kind === 'present' && d.layers.some(l => l.affordanceId === 'b2')).toBe(false)
  })

  // 4. 沉默时维持 merge，且不得使用 enter 专属转译
  it('沉默时维持 merge，且不得使用 enter 专属转译', () => {
    const state: DreamState = { ...initialDreamState(), currentDepth: 'merge', entryConsent: 'unknown' }
    const assessment = makeAssessment([
      { affordanceId: 'a3e', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'strong', actionBridge: 'strong', allowedLayers: ['scene'], evidenceIds: ['e4'], reason: '景物可入梦' },
      { affordanceId: 'a2m', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'weak', actionBridge: 'strong', allowedLayers: ['scene'], evidenceIds: ['e3'], reason: '景物可叠合' },
    ])
    const d = applyDreamLaw(memoryA, WINDOWS.dream_enter, state, { kind: 'silence' }, assessment)
    expect(d.kind === 'present' && d.depth).toBe('merge')
    if (d.kind === 'present') {
      expect(d.layers.some(l => l.affordanceId === 'a3e')).toBe(false)
      expect(d.layers.some(l => l.affordanceId === 'a2m')).toBe(true)
    }
  })

  // 5. 明确拒绝后下一窗口只退不进
  it('decline 后下一窗口只能退出', () => {
    let state = initialDreamState()
    state = applyResponseToState(state, { kind: 'decline', rawText: '不要了' })
    const assessment = makeAssessment([])
    const d = applyDreamLaw(memoryA, WINDOWS.boundary_soft, state, { kind: 'none' }, assessment)
    expect(d.kind).toBe('exit')
  })

  // 6. 惊醒残痕只能来自已出现元素
  it('惊醒残痕必须取自 appearedAffordanceIds', () => {
    const state: DreamState = {
      ...initialDreamState(),
      currentDepth: 'merge',
      activeAffordanceIds: ['a1m'],
      appearedAffordanceIds: ['a1m'],
    }
    const assessment = makeAssessment([
      { affordanceId: 'a1m', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'none', actionBridge: 'none', allowedLayers: ['sound'], evidenceIds: ['e3'], reason: '声音残痕' },
      { affordanceId: 'a3e', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'strong', actionBridge: 'strong', allowedLayers: ['scene'], evidenceIds: ['e4'], reason: '景物' },
    ])
    const d = applyDreamLaw(memoryA, WINDOWS.awaken, state, { kind: 'none' }, assessment)
    if (d.kind === 'exit' && d.residue) {
      expect(d.residue.affordanceId).toBe('a1m')
    }
  })

  // 7. 重复词用位置区分
  it('证据位置必须精确，相同词不同位置可区分', () => {
    const m: DreamMemory = {
      rawText: '院子里的院子',
      evidence: [
        { id: 'e1', text: '院子', start: 0, end: 2, kind: 'place' },
        { id: 'e2', text: '院子', start: 4, end: 6, kind: 'place' },
      ],
      affordances: [],
      forbiddenExamples: [],
    }
    expect(validateMemoryEvidence(m)).toBe(true)
  })

  // 8. 仅有声音桥的转译不得获得 scene 层权限
  it('仅有声音桥的转译不得获得 scene 层权限', () => {
    const assessment = makeAssessment([
      { affordanceId: 'b1m', grounding: 'supported', sensoryBridge: 'strong', spatialBridge: 'none', actionBridge: 'none', allowedLayers: ['sound'], evidenceIds: ['e1'], reason: '仅声音可共存' },
    ])
    const state: DreamState = { ...initialDreamState(), currentDepth: 'merge', entryConsent: 'granted' }
    const d = applyDreamLaw(memoryB, WINDOWS.dream_enter, state, { kind: 'none' }, assessment)
    expect(d.kind).toBe('present')
    if (d.kind === 'present') {
      expect(d.depth).toBe('merge')
      expect(d.layers.every(l => l.layer !== 'scene')).toBe(true)
    }
  })
})
