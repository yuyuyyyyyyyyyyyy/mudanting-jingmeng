interface Props {
  onBack: () => void
}

/**
 * AI 能力说明页：阅读结束后的非强制入口。
 * 保持书籍视觉，不做技术后台。
 */
export default function About({ onBack }: Props) {
  return (
    <div className="subpage">
      <p className="about-position">
        普通阅读器记得你读到哪里。{'\n'}这本书记得你怎样读到这里。
      </p>
      <p className="about-position-sub">
        你选的，戏台记得；后文的原文会回来回应它。
      </p>
      <p className="about-reader" style={{ fontSize: '0.85rem', color: 'var(--ink-soft)', textAlign: 'center', margin: '1vh 0 3vh' }}>
        这本书为高一学生而做——学过课本里的《皂罗袍》，却没有读过完整的《惊梦》。
      </p>
      <h2>这本书刚才做了什么？</h2>
      <ul className="about-list">
        <li>演出中，你选择「先看见什么」——莺声、园门、盛开的花。戏台记住了你的选择。</li>
        <li>AI 根据你的选择，在人工审核过的候选中调度戏台的视觉、声音与节奏——不改变原文与情节。</li>
        <li>你读到后文时，先前选择留意的东西会从原文里回来。这不是 AI 生成的新句子，是汤显祖原文之间本来就存在的关系。</li>
        <li>AI 只在人工确认的候选中调度，不替汤显祖写任何一个字。</li>
        <li>经你同意，只把选中的原文、章节位置、必要的近期阅读轨迹和已审核候选关系发送给 DeepSeek；密钥只保存在本机服务端。</li>
        <li>右上角会如实显示当前使用「DeepSeek 在场」还是「本地兜底」。</li>
        <li>AI 只在你已经读到的原文中寻找回应；你没读到的地方，它不会提前说。</li>
        <li>关键的原文关系——回应、加深、反转、兑现、对照、误读——全部经过人工确认。</li>
        <li>你所读到的原文，没有被 AI 改写；AI 的意见，也不冒充原文。</li>
      </ul>

      <div className="about-flow" aria-label="AI 工作流程示意">
        <span className="flow-step">你的选择</span>
        <span className="flow-arrow">↓</span>
        <span className="flow-step">AI 调度候选</span>
        <span className="flow-arrow">↓</span>
        <span className="flow-step">戏台呈现</span>
        <span className="flow-arrow">↓</span>
        <span className="flow-step">原文回声</span>
      </div>

      <div className="subpage-back">
        <button className="text-entry" onClick={onBack}>回到书页</button>
      </div>
    </div>
  )
}
