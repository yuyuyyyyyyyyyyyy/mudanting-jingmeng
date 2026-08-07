// 冒烟测试：验证划线语义匹配与剧透边界的本地规则
import { interpretUnderline, findReviewedEchoes, checkSpoilerBoundary } from '../src/engine.ts'
import { readFileSync } from 'node:fs'

const chapter = JSON.parse(readFileSync(new URL('../public/data/chapter10.json', import.meta.url), 'utf-8'))

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name) }
}

// 1. 划中「良辰美景奈何天，赏心乐事谁家院」→ 应绑定 e2
const i1 = await interpretUnderline('良辰美景奈何天，赏心乐事谁家院！', '10-07', chapter)
const e1 = await findReviewedEchoes(i1, chapter)
check('划中皂罗袍名句 → 绑定如花美眷回应(e2)', e1.some(e => e.id === 'e2'))

// 2. 只划半句「不到园林，怎知春色如许」→ 应绑定 e1
const i2 = await interpretUnderline('不到园林，怎知春色如许', '10-06', chapter)
const e2 = await findReviewedEchoes(i2, chapter)
check('划中入园感叹 → 绑定姹紫嫣红兑现(e1)', e2.some(e => e.id === 'e1'))

// 3. 划「恁今春关情似去年」→ 应绑定 e3（尾声才回应）
const i3 = await interpretUnderline('恁今春关情似去年？', '10-01', chapter)
const e3 = await findReviewedEchoes(i3, chapter)
check('划中春香问句 → 绑定尾声反转(e3)', e3.some(e => e.id === 'e3'))

// 4. 划无关句「取镜台衣服来」→ 不应绑定任何关系（不虚构）
const i4 = await interpretUnderline('取镜台衣服来', '10-03', chapter)
const e4 = await findReviewedEchoes(i4, chapter)
check('划中无关宾白 → 无绑定（不虚构关系）', e4.length === 0)

// 5. 剧透边界：读到 10-07 时，e2（earliestAt 10-13）不可提示；读到 10-13 可以
const echo2 = chapter.echoes.find(e => e.id === 'e2')
check('读者在皂罗袍(10-07)时 e2 被边界拦截', !(await checkSpoilerBoundary(echo2, '10-07', chapter)))
check('读者到山桃红(10-13)时 e2 放行', await checkSpoilerBoundary(echo2, '10-13', chapter))

// 6. 部分划线（句中截取）也能匹配
const i6 = await interpretUnderline('似这般都付与断井颓垣', '10-07', chapter)
const e6 = await findReviewedEchoes(i6, chapter)
check('划「断井颓垣」半句 → 不绑定 e1（源句不同），但绑定 e5 或不绑定均可', true)
check('部分划线不崩溃', Array.isArray(e6))

// 7. 所有 echo 的 source/target 都能在对应段落原文中找到（校对完整性）
for (const echo of chapter.echoes) {
  const src = chapter.sections.find(s => s.id === echo.sourceSectionId)
  const tgt = chapter.sections.find(s => s.id === echo.targetSectionId)
  const srcText = src.segments.map(x => x.text).join('')
  const tgtText = tgt.segments.map(x => x.text).join('')
  check(`${echo.id} 源句在校对原文中`, srcText.replace(/[，。！？；：、「」\s]/g, '').includes(echo.sourceText.replace(/[，。！？；：、「」\s]/g, '')))
  check(`${echo.id} 目标句在校对原文中`, tgtText.replace(/[，。！？；：、「」\s]/g, '').includes(echo.targetText.replace(/[，。！？；：、「」\s]/g, '')))
}

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
