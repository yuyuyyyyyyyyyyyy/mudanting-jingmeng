// B 版 Agent 与测试支持测试
// 运行：node --experimental-strip-types test/b-agent.test.mjs
import { inferReadingPath, localSelectCandidate, validateCandidate } from '../src/b-agent.ts'
import { readFileSync } from 'node:fs'

const table = JSON.parse(readFileSync(new URL('../public/data/b-response-candidates.json', import.meta.url), 'utf-8'))

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name) }
}

// ============================================================
// 1. inferReadingPath：把学生选句映射到阅读理解类别
// ============================================================
check('写景惜春：姹紫嫣红 → 写景惜春',
  inferReadingPath('原来姹紫嫣红开遍', '') === '写景惜春')
check('写景惜春：良辰美景 → 写景惜春',
  inferReadingPath('良辰美景奈何天', '') === '写景惜春')
check('自伤身世：锦屏人 → 自伤身世',
  inferReadingPath('锦屏人忒看的这韶光贱', '') === '自伤身世')
check('自伤身世：颜色如花命如一叶 → 自伤身世',
  inferReadingPath('可惜妾身颜色如花，岂料命如一叶乎', '') === '自伤身世')
check('春情初动：春情难遣 → 春情初动',
  inferReadingPath('没乱里春情难遣', '') === '春情初动')
check('梦醒失落：南柯一梦 → 梦醒失落',
  inferReadingPath('乃是南柯一梦', '') === '梦醒失落')
check('梦醒失落：如有所失 → 梦醒失落',
  inferReadingPath('自觉如有所失', '') === '梦醒失落')
check('其他或不确定：无关句 → 其他或不确定',
  inferReadingPath('取镜台衣服来', '') === '其他或不确定')

// 初始理解也参与推断
check('初始理解 + 选句共同推断',
  inferReadingPath('不到园林', '我觉得是写春天的好景') === '写景惜春')

// ============================================================
// 2. 候选表完整性：每条候选字段齐全、原文来自寻梦、relation 合法
// ============================================================
const validRelations = new Set(['支持', '深化', '转折', '反证'])
const validPaths = new Set(table.readingPaths)
check('候选表至少 5 条', table.candidates.length >= 5)
for (const c of table.candidates) {
  check(`${c.id}.reviewed = true`, c.reviewed === true)
  check(`${c.id}.relation 合法`, validRelations.has(c.relation))
  check(`${c.id}.readingPath 在 readingPaths 中`, validPaths.has(c.readingPath))
  check(`${c.id}.sourceText 非空`, typeof c.sourceText === 'string' && c.sourceText.length > 0)
  check(`${c.id}.hint ≤ 50 字`, typeof c.hint === 'string' && c.hint.length <= 50)
  check(`${c.id}.chapterId = 12（来自寻梦）`, c.chapterId === '12')
  // 禁用文案
  check(`${c.id}.hint 不含"正确答案是"`, !c.hint.includes('正确答案是'))
  check(`${c.id}.hint 不含"你忽略了"`, !c.hint.includes('你忽略了'))
  check(`${c.id}.hint 不含"这证明了"`, !c.hint.includes('这证明了'))
}

// ============================================================
// 3. localSelectCandidate：每个 readingPath 都有候选
// ============================================================
for (const path of table.readingPaths) {
  const c = localSelectCandidate(table, path)
  check(`localSelectCandidate(${path}) 返回候选`, !!c)
  check(`localSelectCandidate(${path}) 的 readingPath 匹配`, c && c.readingPath === path)
}
check('localSelectCandidate(未知类别) → 兜底 neutral',
  localSelectCandidate(table, '不存在的类别')?.readingPath === '其他或不确定')

// ============================================================
// 4. validateCandidate：只允许审核候选 ID
// ============================================================
check('validateCandidate(r1) 合法', !!validateCandidate(table, 'r1'))
check('validateCandidate(非法ID) 返回 null', validateCandidate(table, 'rX-invalid') === null)
check('validateCandidate(空串) 返回 null', validateCandidate(table, '') === null)

// 模拟 AI 返回非法 ID → 前端应判非法并走本地兜底
const fakeAiId = 'r99-not-in-table'
check('AI 返回非法 ID 时 validateCandidate 返回 null', validateCandidate(table, fakeAiId) === null)

// ============================================================
// 5. 离线兜底链路：给定一个学生选句，本地能选出候选
// ============================================================
function simulateLocal(pinText, initial) {
  const path = inferReadingPath(pinText, initial)
  const c = localSelectCandidate(table, path)
  return { path, candidate: c }
}
const sim1 = simulateLocal('原来姹紫嫣红开遍', '')
check('兜底：写景惜春 → r1', sim1.candidate?.id === 'r1')
const sim2 = simulateLocal('锦屏人忒看的这韶光贱', '')
check('兜底：自伤身世 → r2', sim2.candidate?.id === 'r2')
const sim3 = simulateLocal('没乱里春情难遣', '')
check('兜底：春情初动 → r3', sim3.candidate?.id === 'r3')
const sim4 = simulateLocal('乃是南柯一梦', '')
check('兜底：梦醒失落 → r4', sim4.candidate?.id === 'r4')
const sim5 = simulateLocal('取镜台衣服来', '')
check('兜底：其他 → r5', sim5.candidate?.id === 'r5')

console.log(`\n${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
