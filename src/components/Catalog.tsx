import type { Catalog } from '../types'
import type { Persisted } from '../store'

interface Props {
  catalog: Catalog
  state: Persisted
  onEnterChapter: (chapterId: string) => void
  onBack: () => void
  onClear: () => void
}

const CN_NUM = ['一','二','三','四','五','六','七','八','九','十']

function cnNum(n: number): string {
  if (n <= 10) return CN_NUM[n - 1]
  if (n < 20) return '十' + CN_NUM[n - 11]
  const tens = Math.floor(n / 10)
  const rest = n % 10
  return CN_NUM[tens - 1] + '十' + (rest ? CN_NUM[rest - 1] : '')
}

/**
 * 五十五出完整目录：像真正书籍的目录，不做网格卡片。
 * 没有可靠文本的章节不开放，也不由 AI 编造。
 */
export default function CatalogView({ catalog, state, onEnterChapter, onBack, onClear }: Props) {
  const underlineCount = state.underlines.length
  const readState = (id: string) => {
    if (id !== '10' && id !== '12') return ''
    if (state.progress.finished) return '已读完'
    if (state.progress.maxRevealed > 0) return '读到一半'
    return '未读'
  }

  return (
    <div className="subpage" style={{ maxWidth: '30rem' }}>
      <h2>牡丹亭　五十五出</h2>
      <ul className="catalog-list">
        {catalog.chapters.map(c => (
          <li
            key={c.id}
            className={`catalog-item ${c.status}`}
            onClick={c.status === 'ready' ? () => onEnterChapter(c.id) : undefined}
            aria-disabled={c.status !== 'ready'}
          >
            <span className="c-no">第{cnNum(Number(c.id))}出</span>
            <span className="c-title">{c.title}</span>
            <span className="c-lines">{c.id === '10' && underlineCount > 0 ? `划线 ${underlineCount} 处` : ''}</span>
            <span className="c-state">
              {c.status === 'ready'
                ? `${readState(c.id)} · 深度设计完成`
                : '原文校对中 · AI关系整理中'}
            </span>
          </li>
        ))}
      </ul>

      <p className="catalog-note">{catalog.note}</p>

      <div className="catalog-tools">
        <button className="text-entry-small" onClick={onBack}>回到扉页</button>
        <button
          className="text-entry-small"
          onClick={() => {
            if (window.confirm('将清除本机上保存的全部划线、批注与阅读进度。确定吗？')) onClear()
          }}
        >
          清除本次 Demo 数据
        </button>
      </div>
    </div>
  )
}
