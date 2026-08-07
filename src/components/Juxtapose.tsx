import { useState } from 'react'
import type { Echo, Underline } from '../types'

export interface JuxtaposeData {
  echo: Echo
  underline: Underline
}

interface Props {
  data: JuxtaposeData
  onClose: () => void
}

/**
 * 两段原文的临时并置。
 * 不立即出现解释；解释入口很小，点开才显示，且明确标注可关闭。
 */
export default function Juxtapose({ data, onClose }: Props) {
  const [showWhy, setShowWhy] = useState(false)
  const { echo, underline } = data

  return (
    <div className="juxtapose-mask" onClick={onClose} role="dialog" aria-modal="true" aria-label="两段原文并置">
      <div className="juxtapose" onClick={e => e.stopPropagation()}>
        <p className="jx-block jx-source">
          <span className="jx-tag">你当时留下的</span>
          <span className="jx-text">{underline.text}</span>
        </p>
        <div className="jx-gap" aria-hidden="true" />
        <p className="jx-block">
          <span className="jx-tag">后来原文说 · {echo.relation}</span>
          <span className="jx-text-target">{echo.targetText}</span>
        </p>

        {!showWhy ? (
          <div className="jx-why">
            <button className="text-entry-small" onClick={() => setShowWhy(true)}>
              它们为什么会彼此回应？
            </button>
          </div>
        ) : (
          <div className="jx-explain">
            <div className="ai-tag">
              <span>AI阅读提示 · 可关闭</span>
              <button onClick={() => setShowWhy(false)} aria-label="关闭提示">收起</button>
            </div>
            {echo.explanation}
          </div>
        )}

        <div className="jx-close">
          <button className="text-entry-small" onClick={onClose}>回到原文</button>
        </div>
      </div>
    </div>
  )
}
