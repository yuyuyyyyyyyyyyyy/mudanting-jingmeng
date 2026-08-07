import { useState } from 'react'
import GardenOpening from './dream/GardenOpening'
import GardenReader from './dream/GardenReader'

/**
 * 唯一版本：翻阅式 AI 阅读《牡丹亭·惊梦》。
 * 不再有多版本入口——打开即「月门花影」开场 → 一页一页读。
 */
export default function App() {
  const [fusionKey, setFusionKey] = useState(0)
  const [fusionEntered, setFusionEntered] = useState(false)
  // 翻阅式阅读的控件状态：开始页与内容页共享（开屏即可全屏/调音/动效）
  const [fusionSound, setFusionSound] = useState(true)
  const [fusionMotion, setFusionMotion] = useState(true)
  const [fusionVernacular, setFusionVernacular] = useState(true)

  if (!fusionEntered) {
    return (
      <GardenOpening
        onEnter={() => setFusionEntered(true)}
        soundOn={fusionSound}
        motionOn={fusionMotion}
        vernacularOn={fusionVernacular}
        onSoundToggle={() => setFusionSound(s => !s)}
        onMotionToggle={() => setFusionMotion(s => !s)}
        onVernacularToggle={() => setFusionVernacular(s => !s)}
      />
    )
  }

  return (
    <GardenReader
      key={fusionKey}
      onReenter={() => setFusionKey(k => k + 1)}
      soundOn={fusionSound}
      motionOn={fusionMotion}
      vernacularOn={fusionVernacular}
      onSoundToggle={() => setFusionSound(s => !s)}
      onMotionToggle={() => setFusionMotion(s => !s)}
      onVernacularToggle={() => setFusionVernacular(s => !s)}
    />
  )
}
