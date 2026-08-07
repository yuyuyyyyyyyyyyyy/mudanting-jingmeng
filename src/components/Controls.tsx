interface Props {
  sound: boolean
  motion: boolean
  vernacular: boolean
  semantic: 'deepseek' | 'checking' | 'local'
  onToggleSound: () => void
  onToggleMotion: () => void
  onToggleVernacular: () => void
}

export default function Controls({ sound, motion, vernacular, semantic, onToggleSound, onToggleMotion, onToggleVernacular }: Props) {
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.log('[fullscreen] request failed:', err)
      })
    } else {
      document.exitFullscreen().catch((err) => {
        console.log('[fullscreen] exit failed:', err)
      })
    }
  }

  return (
    <div className="controls" role="group" aria-label="阅读控制">
      {semantic !== 'deepseek' && semantic !== 'checking' && (
        <span className={`semantic-status semantic-${semantic}`} title="戏台暂用本地规则兜底">
          戏台自守
        </span>
      )}
      <button onClick={toggleFullscreen} aria-label="全屏观看" title="全屏观看">
        全屏
      </button>
      <button onClick={onToggleVernacular} aria-pressed={vernacular}>
        今译 <span className="state">{vernacular ? '开' : '关'}</span>
      </button>
      <button onClick={onToggleSound} aria-pressed={sound}>
        声音 <span className="state">{sound ? '开' : '关'}</span>
      </button>
      <button onClick={onToggleMotion} aria-pressed={motion}>
        动效 <span className="state">{motion ? '开' : '关'}</span>
      </button>
    </div>
  )
}
