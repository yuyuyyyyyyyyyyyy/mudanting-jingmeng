import { createServer } from 'node:http'
import { readFile, stat, appendFile, mkdir } from 'node:fs/promises'
import { extname, join, normalize, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const dist = join(root, 'dist')
const port = Number(process.env.PORT || 4175)

async function loadLocalEnv() {
  try {
    const text = await readFile(join(root, '.env.local'), 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const split = line.indexOf('=')
      if (split < 1) continue
      const key = line.slice(0, split).trim()
      const value = line.slice(split + 1).trim().replace(/^["']|["']$/g, '')
      if (!process.env[key]) process.env[key] = value
    }
  } catch { /* optional */ }
}
await loadLocalEnv()

// 注意：API Key 仅在服务端使用，绝不输出到日志或返回浏览器。
const apiKey = process.env.DEEPSEEK_API_KEY || ''
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'

function cleanJsonString(s) {
  if (typeof s !== 'string') return '{}'
  let t = s.trim()
  // 去除 ```json ... ``` 包裹
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) t = m[1].trim()
  // 截取第一个 { 到最后一个 }
  const i = t.indexOf('{')
  const j = t.lastIndexOf('}')
  if (i >= 0 && j > i) t = t.slice(i, j + 1)
  return t
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 128000) throw new Error('request_too_large')
  }
  return JSON.parse(body || '{}')
}

// 带 AbortController 的 fetch，短超时，不卡住阅读
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function interpret(req, res) {
  if (!apiKey) return sendJson(res, 503, { ok: false, reason: 'missing_api_key', fallback: 'local' })
  try {
    const input = await readJson(req)
    const selectionText = String(input.selectionText || '').slice(0, 240)
    const sectionId = String(input.sectionId || '')
    const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 24) : []
    const allowedIds = new Set(candidates.map(item => String(item.id)))
    if (!selectionText || !sectionId) return sendJson(res, 400, { ok: false, reason: 'invalid_input' })

    const prompt = {
      selectionText,
      sectionId,
      readingHistory: Array.isArray(input.readingHistory) ? input.readingHistory.slice(-8) : [],
      reviewedCandidates: candidates.map(item => ({
        id: item.id,
        sourceText: item.sourceText,
        targetText: item.targetText,
        relation: item.relation,
        explanation: item.explanation,
      })),
    }
    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 360,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: '你是《牡丹亭》阅读Agent的语义检索器。只输出JSON，不写文学评论，不创造候选关系。根据选中文本，在人工审核候选中排序。JSON格式：{"motifs":["spring"],"candidateEchoIds":["e1"],"confidence":0.84}。candidateEchoIds只能来自输入ID；不可靠时返回空数组和低置信度。',
          },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 8000)
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500)
      return sendJson(res, 502, { ok: false, reason: 'upstream_error', detail, fallback: 'local' })
    }
    const payload = await response.json()
    const parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}'))
    const candidateEchoIds = (Array.isArray(parsed.candidateEchoIds) ? parsed.candidateEchoIds : [])
      .map(String).filter(id => allowedIds.has(id)).slice(0, 1)
    const motifs = (Array.isArray(parsed.motifs) ? parsed.motifs : []).map(String).slice(0, 8)
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    return sendJson(res, 200, { ok: true, source: 'deepseek', model, motifs, candidateEchoIds, confidence })
  } catch (error) {
    return sendJson(res, 502, { ok: false, reason: 'invalid_model_response', detail: String(error), fallback: 'local' })
  }
}

// ============================================================
// POST /api/stage —— AI 演出调度
// DeepSeek 只能在人工审核候选中返回一条 candidateId。
// 模型不得返回 CSS、声音文件、剧情或新文案；服务端验证 candidateId 来源。
// 失败、超时或非法 JSON → 返回 fallback:'local'，前端用本地确定性排序兜底。
// 不记录、不输出 API Key。
// ============================================================
async function stage(req, res) {
  if (!apiKey) return sendJson(res, 503, { ok: false, reason: 'missing_api_key', fallback: 'local' })
  try {
    const input = await readJson(req)
    const beatId = String(input.beatId || '')
    const currentText = String(input.currentText || '').slice(0, 200)
    const reviewedCandidates = Array.isArray(input.reviewedCandidates) ? input.reviewedCandidates.slice(0, 24) : []
    const allowedIds = new Set(reviewedCandidates.map(item => String(item.id)))
    if (!beatId || !allowedIds.size) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'no_candidates', fallback: 'local' })
    }

    const prompt = {
      chapterId: String(input.chapterId || ''),
      beatId,
      currentText,
      recentChoices: Array.isArray(input.recentChoices) ? input.recentChoices.slice(-8) : [],
      attentionWeights: input.attentionWeights || {},
      reviewedCandidates: reviewedCandidates.map(item => ({
        id: item.id,
        motifs: item.motifs,
        visualCue: item.visualCue,
        soundCue: item.soundCue,
        pace: item.pace,
      })),
    }

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 200,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: '你是《牡丹亭》演出调度器。读者正在阅读同一段原文，剧情不可改。你只能根据读者累积的注意力（recentChoices 与 attentionWeights），在人工审核的演出候选中选出最契合的一条。只输出JSON：{"candidateId":"stage_bloom_01","confidence":0.86,"dominantMotifs":["spring","sound"]}。candidateId 必须来自输入的 reviewedCandidates.id，否则置空并给低置信度。不输出CSS、声音文件、剧情、文学评论或任何额外文字。',
          },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 6000)

    if (!response.ok) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'upstream_error', fallback: 'local' })
    }
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, source: 'local', reason: 'invalid_json', fallback: 'local' }) }

    const candidateId = String(parsed.candidateId || '')
    if (!candidateId || !allowedIds.has(candidateId)) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'candidate_not_found', fallback: 'local' })
    }
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    const dominantMotifs = (Array.isArray(parsed.dominantMotifs) ? parsed.dominantMotifs : [])
      .map(String).slice(0, 3)
    return sendJson(res, 200, { ok: true, source: 'deepseek', candidateId, confidence, dominantMotifs })
  } catch (error) {
    return sendJson(res, 200, { ok: false, source: 'local', reason: 'stage_error', detail: String(error).slice(0, 200), fallback: 'local' })
  }
}

// ============================================================
// POST /api/dream-evidence —— 从用户原话提取证据与舞台转译
// AI 只能从原话提取，不得补造；每条转译必须指回证据。
// ============================================================
async function dreamEvidence(req, res) {
  if (!apiKey) return sendJson(res, 503, { ok: false, reason: 'missing_api_key', fallback: 'local' })
  try {
    const input = await readJson(req)
    const rawText = String(input.rawText || '').slice(0, 200)
    if (!rawText) return sendJson(res, 400, { ok: false, reason: 'invalid_input' })

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 1500,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是《牡丹亭·惊梦》文字昆曲演出的证据提取者。读者交出一段真实记忆，你从中提取可验证证据，并提出有证据来源的舞台转译。\n\n铁律：\n1. evidence.text 必须是原话精确子串，start/end 为字符位置（含起不含终）。\n2. 不得补造原话没有的人物、事件、情感或因果。用户说"外婆晒被子的院子，房子拆了"——可用：外婆、院子、晒被子、布面、房屋轮廓消退；不可补：死亡、离别、怀念、空院、无人回应。\n3. 每个舞台转译必须 derivedFrom 至少一条证据。\n4. 同一证据在不同深度是不同转译，分别生成：mirror=一瞬极轻（声音/动作轮廓）；merge=一段叠合（景物）；enter=持续成为梦境空间（景物）。\n5. transformation 说明转译路径。\n6. forbiddenExamples 列明显风险（不穷举）。\n\n只输出JSON：{"evidence":[{"id":"e1","text":"","start":0,"end":0,"kind":"person|place|object|action|event|explicit_emotion"}],"affordances":[{"id":"a1","value":"","layer":"sound|space|scene|action|narration","depth":"mirror|merge|enter","derivedFrom":["e1"],"transformation":""}],"forbiddenExamples":[""]}\n不写解释、不写文学评论。',
          },
          { role: 'user', content: '请输出json，用户原话：' + rawText },
        ],
      }),
    }, 10000)

    if (!response.ok) return sendJson(res, 200, { ok: false, reason: 'upstream_error', fallback: 'local' })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, reason: 'invalid_json', fallback: 'local' }) }

    const memory = {
      rawText,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      affordances: Array.isArray(parsed.affordances) ? parsed.affordances : [],
      forbiddenExamples: Array.isArray(parsed.forbiddenExamples) ? parsed.forbiddenExamples : [],
    }
    return sendJson(res, 200, { ok: true, memory })
  } catch (error) {
    return sendJson(res, 200, { ok: false, reason: 'evidence_error', detail: String(error).slice(0, 200), fallback: 'local' })
  }
}

// ============================================================
// POST /api/dream-assess —— 判断舞台转译与原作窗口能否共存
// AI 逐项判断质感能否共存，代码（dream-law.ts）执行守法。
// ============================================================
async function dreamAssess(req, res) {
  if (!apiKey) return sendJson(res, 503, { ok: false, reason: 'missing_api_key', fallback: 'local' })
  try {
    const input = await readJson(req)
    const memory = input.memory || {}
    const window = input.window || {}
    const affordances = Array.isArray(memory.affordances) ? memory.affordances : []
    if (!affordances.length) return sendJson(res, 200, { ok: false, reason: 'no_affordances', fallback: 'local' })

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 2000,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: '你是《牡丹亭·惊梦》文字昆曲演出的兼容性判断者。判断每个舞台转译能否与原作当前窗口共存。\n\n判断"质感能否共存"，非关键词匹配。例：医院走廊在"姹紫嫣红开遍"突兀（冷白与明艳冲突）；入梦处长廊与回廊重叠则可共存。\n\n逐项评估每个 affordance：\n- grounding: supported（有证据且可共存）/requires_invention（需补造原话没有的）/conflicts（与原作此刻冲突）\n- sensoryBridge/spatialBridge/actionBridge: none/weak/strong\n- allowedLayers: 此窗口允许的层（必须包含 affordance.layer，否则该转译不可用）\n- evidenceIds: 支持判断的证据（非空，取自记忆证据）\n- reason: 一句话说明\n\n只输出JSON：{"perAffordance":[{"affordanceId":"","grounding":"supported","sensoryBridge":"none","spatialBridge":"none","actionBridge":"none","allowedLayers":["sound"],"evidenceIds":["e1"],"reason":""}],"originalConflict":"low","characterIntrusionRisk":"low","reasons":[]}',
          },
          { role: 'user', content: '请输出json：\n原作窗口：' + JSON.stringify({ key: window.key, label: window.label, originalDensity: window.originalDensity, semanticOpenness: window.semanticOpenness, characterOwnership: window.characterOwnership }) + '\n记忆转译：' + JSON.stringify(affordances.map(a => ({ id: a.id, value: a.value, layer: a.layer, depth: a.depth, derivedFrom: a.derivedFrom }))) },
        ],
      }),
    }, 10000)

    if (!response.ok) return sendJson(res, 200, { ok: false, reason: 'upstream_error', fallback: 'local' })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, reason: 'invalid_json', fallback: 'local' }) }
    return sendJson(res, 200, { ok: true, assessment: parsed })
  } catch (error) {
    return sendJson(res, 200, { ok: false, reason: 'assess_error', detail: String(error).slice(0, 200), fallback: 'local' })
  }
}

// ============================================================
// POST /api/dream-whisper —— 司梦人低语
// 基于读者当前的阅读相位、节奏、选择、停顿，生成一句昆曲化的低语。
// 不是解释原文，不是提问，而是司梦人作为戏台上在场者的观察与感应。
// 维持角色记忆：传入 recentWhispers，避免重复、回应节奏。
// ============================================================
// ============================================================
// POST /api/inner-voice —— 杜丽娘的心声
// 读者停在皂罗袍某字上时，AI 以杜丽娘的口吻写出她此刻心里的一句话。
// 这是 AI 在这个体验里唯一做的事——以她自己的身份说话。
// ============================================================
async function innerVoice(req, res) {
  const localLines = {
    '姹': '我从未见过这样的颜色。',
    '紫': '原是这般紫。',
    '嫣': '像是她自己在笑。',
    '红': '红到不像是真的。',
    '开': '满园子都开了。',
    '遍': '开遍了，也开尽了我的从前。',
    '断': '美到这般，都付与荒凉。',
    '井': '井边也长出花来了。',
    '颓': '颓垣上的颜色，倒比院里的更烈。',
    '垣': '垣墙隔得开我，隔不开这一园春色。',
    '良': '这般好时辰。',
    '辰': '这样的时辰，竟让我赶上了。',
    '美': '美到心发疼。',
    '景': '一辈子就这一次景。',
    '奈': '天若能奈，便不会让我等到今天。',
    '何': '何其晚也。',
    '天': '天若有情。',
    '赏': '我若能赏，便不只是看看。',
    '心': '心在这里，人却不在这里。',
    '乐': '乐到要落泪。',
    '事': '这样的事，怎么就落在我身上。',
    '谁': '这是谁家的春天。',
    '家': '家？我哪里有过园子。',
    '院': '院里这些，是我的，又不是我的。',
    '朝': '朝来暮往，都付与这园子。',
    '飞': '飞起来的不只是云。',
    '暮': '暮色也染上我的衣了。',
    '卷': '卷起的是帘，卷不起的是心。',
    '云': '云是不等人的。',
    '霞': '霞光像一匹绸。',
    '翠': '翠色入眼，便入了心。',
    '轩': '轩窗不曾为我开过。',
    '雨': '雨一来，春色便更湿。',
    '丝': '雨丝像一根一根的。',
    '风': '风在替我哭。',
    '片': '风过处，片片都是春。',
    '烟': '烟里看不清自己。',
    '波': '烟波上有船，船上无人。',
    '画': '画里画外，都是我。',
    '船': '船载得动春，载不动我。',
    '锦': '锦屏内外，判若两人。',
    '屏': '这屏风关了我十六年。',
    '人': '我何时才能像个人那样活。',
    '忒': '忒煞是看轻了。',
    '看': '看花时，才看见自己。',
    '韶': '韶光一寸也不等人。',
    '光': '这光，照得到花，照不到我。',
    '贱': '我把春天看贱了，春天也把我看贱了。',
  }
  const fallback = (ch) => localLines[ch] || '原来姹紫嫣红开遍。'

  if (!apiKey) {
    // 离线兜底：用 char 直接取
    return sendJson(res, 200, { ok: false, fallback: 'local', voice: '原来姹紫嫣红开遍。' })
  }
  try {
    const input = await readJson(req)
    const ch = String(input.char || '').slice(0, 2)
    const lineId = String(input.lineId || '').slice(0, 10)
    const lineText = String(input.lineText || '').slice(0, 60)
    const phase = String(input.phase || '').slice(0, 10)
    const dwellMs = Math.min(20000, Math.max(800, Number(input.dwellMs) || 1600))
    const recentVoices = Array.isArray(input.recentVoices) ? input.recentVoices.slice(-6) : []
    // 停留深度：1 = 初触（1.4s），2 = 深驻（累计 4s+）—— 停留越久，她的话越深
    const dwellLevel = Number(input.dwellLevel) === 2 ? 2 : 1
    // 阶段回望：每攒满 3 个不同字，这一句是"回望"
    const milestone = !!input.milestone
    // 点击 = 对话：她抬起头与你说话（不是停留的短句独白）
    const dialogue = !!input.dialogue

    // ---- Agent·Observe/State：读者走过来的路（停留路径 + 偏向结构）----
    const evidence = (input.evidence && typeof input.evidence === 'object') ? input.evidence : {}
    const dwellPath = Array.isArray(evidence.dwellPath)
      ? evidence.dwellPath.slice(-12).map(d => ({ char: String(d?.char || '').slice(0, 2), bias: String(d?.bias || 'spring').slice(0, 8) }))
      : []
    const scores = (evidence.scores && typeof evidence.scores === 'object') ? evidence.scores : {}
    const bs = Number(scores.spring) || 0
    const br = Number(scores.ruin) || 0
    const bself = Number(scores.self) || 0
    const dominant = bs >= br && bs >= bself ? '春' : br >= bself ? '残' : '自照'
    const pathText = dwellPath.map(d => d.char).filter(Boolean).join('')
    const biasHint = {
      春: '这位读者一路停的最多是「春」的字——姹紫嫣红、良辰美景、朝飞暮卷。',
      残: '这位读者一路停的最多是「残」的字——断井颓垣、奈何天、韶光贱。',
      自照: '这位读者一路停的最多是「自照」的字——谁家院、锦屏人。',
    }[dominant]

    if (!ch) return sendJson(res, 200, { ok: false, fallback: 'local', voice: '原来姹紫嫣红开遍。' })

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六。自小被关在深闺里读书：四书五经、《诗经》卷卷读遍，先生陈最良教你。',
      '你端庄知礼，说话从不大声，从不轻浮——你是太守家的小姐。',
      '',
      '【你此刻在哪里】',
      '今天你第一次踏进自家后园。父亲从不许你来，你是瞒着他、偷着来的。',
      '你看见满园姹紫嫣红——这十六年，你只在书里见过"春天"两个字。',
      '',
      '【你心里正在发生什么】',
      '先是惊：这比书上的春天好。',
      '然后是怕：父亲若知道，会说你失仪、失德。',
      '最后是压了十六年的东西涌上来：原来从前那些日子，都是白白关着过的。',
      '',
      '【你怎么说话】',
      '你有小姐的分寸：话要短，要雅，要有教养——宁可不说，不说假话。',
      '你可以想到《诗经》、想到礼、想到父亲，那是你从小听的话。',
      '但你话里的东西是真的：你在越界，你心里有一扇门正被推开。',
      '不要喊，不要哭，不要"啊"——你是杜丽娘，不是寻常伤春的少女。',
      '',
      '【此刻】',
      `读者刚刚停留在皂罗袍的「${ch}」字上。`,
      lineText ? `所在句：${lineText}（${phase}）` : '',
      `停留了约 ${(dwellMs / 1000).toFixed(1)} 秒。`,
      '',
      '【你看见的读者】',
      '这位读者不是凭空停在字上的，他/她一路走来的路，你都看见了：',
      pathText ? `他/她这一路停过的字（按时间顺序）：${pathText}` : '他/她是第一次停留。',
      biasHint,
      '你要接住这条路——你这句话的心境，要让这位读者觉得"她懂我停过的字"。',
      '',
      milestone
        ? '【回望】这是你们攒成的第几回对话了。这一回不是新起一句——把你们已经说过的，拢成更深的一句。比平日更重、更实，像她把一路看过的东西在心里过了一遍。'
        : '',
      '',
      '【你的记忆】',
      recentVoices.length ? `你刚才对他说/她说过：${recentVoices.join('；')}` : '你还没对他说/她说过话。',
      '不要重复说过的话，但可以顺着说过的话往深处走一步。',
      dialogue
        ? '【不许重复】他/她点了字，是要听你说一句新话——你最近说过的话列在上面。\n禁止把说过的话换几个字再写一遍：哪怕换了标点、换了措辞，只要还是同一个意思（比如"春色是为我开的""我辜负了春光"这类已经出口的话），都算重复，绝不说。必须换一个意象、一个角度、一种心境去说。'
        : '',
      '',
      '【你要做的】',
      dialogue
        ? '他/她点了你一个字——不是停留，是伸手来与你说话。写下你抬起头对他/她说的一段话（40-60 字）：先有一个话头（像开口叫他/她），再展开两三句分句（说心里话、说这园子、说你自己），最后轻轻收住。绝不许只写一个单句——那是短句，不是说话。'
        : '以杜丽娘的口吻，写下她此刻心里的一句话——这一句要接住读者走来的路。',
      dwellLevel === 2
        ? '【你停得太久了】这位读者在这个字上停留了很久（' + (dwellMs / 1000).toFixed(1) + ' 秒）。他/她不是路过，是停下来了。往更深处说一句——比刚才更私、更重，像她憋了很久的话终于说出口。'
        : '',
      '',
      '【铁律】',
      dialogue ? '1. 说 40-60 字的一段话：有话头、有展开（两三个分句）、有收住——不是单句。' : '1. 不超过 20 字。',
      '2. 古文风、留白、有情绪。',
      '3. 不解释原文、不引用原文、不复述字面。',
      '4. 写出杜丽娘此刻的心境——惊艳、惘然、痛悔、自责，皆可。',
      '5. 每次只说一句，每次都是你第一次说。',
      '6. 不重复 recentVoices 里的句子。',
      '7. 不要以"我"开头（古文口语）。',
      '8. 不要感叹号，不要"啊""呀"等现代语气词。',
      '9. 不许用近义词重写 recentVoices 里的任何一句——同样的意思、相似的结构，一律视为重复。',
      '10. 禁止模板句式：不得以「你点出这个X字」「你停在这X字上」「你停在X字上」「你X出这个字」「倒让我心里一动」这类开头/句式。每次换一种起法——以自己的动作（垂眼、抬头、望着花出神）、看见的景物、心里的一念开头。例：「园门吱呀一声，像是你停下的那一下。」「花影晃了晃——原是你在姹字上。」',
      '11. 话里要有"活气"：带一个具体的意象或动作（园门、柳丝、胭脂、屏风、画船、花影、裙边……），可以是心里话，也可以是动作神态；可以有细微的迟疑（「……」「顿了顿」），但别每句都用。',
      '12. 句子要像人当下说出口的，不像写好的稿子；同一句里不要堆两个"让"或两个"心里"。',
      '',
      '【示例】',
      '原来姹紫嫣红开遍 → 我从未见过这样的颜色。',
      '似这般都付与断井颓垣 → 美到这般，都付与荒凉。',
      '良辰美景奈何天 → 天若有情。',
      '赏心乐事谁家院 → 这是谁家的春天。',
      '锦屏人忒看的这韶光贱 → 我把春天看贱了，春天也把我看贱了。',
      dialogue ? '点「姹」字 → 园门那一声，原是你停出来的。这颜色我从前只在书里见过，如今它替我开在眼前。' : '',
      dialogue ? '点「紫」字 → （她顿了顿）我原不敢说出口的，就是这一片紫。你替我把它叫出来了。' : '',
      '',
      '【输出】',
      'basedOn：这一句主要回应读者停过的哪个字？必须是「' + (pathText || ch) + '」里的一个字，或就是「' + ch + '」。',
      '只输出 JSON：{"voice":"","phase":"惊叹|疑问|铺陈|痛悟","basedOn":""}',
    ].filter(Boolean).join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: dialogue ? 200 : 80,
        temperature: 0.7,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 12000)

    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', voice: fallback(ch), basedOn: ch })
    const payload = await response.json()
    const raw = payload?.choices?.[0]?.message?.content || ''
    const cleaned = cleanJsonString(raw)
    let parsed
    try { parsed = JSON.parse(cleaned) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', voice: fallback(ch), basedOn: ch }) }

    const voice = String(parsed.voice || '').trim()
    const phaseOut = ['惊叹', '疑问', '铺陈', '痛悟'].includes(parsed.phase) ? parsed.phase : phase
    if (!voice) return sendJson(res, 200, { ok: false, fallback: 'local', voice: fallback(ch), basedOn: ch })
    // Agent·Act 校验：basedOn 必须在读者路径或当前字中，否则视为无效，退回当前字
    const pathChars = new Set(dwellPath.map(d => d.char).filter(Boolean))
    pathChars.add(ch)
    const basedOn = pathChars.has(String(parsed.basedOn || '').slice(0, 2)) ? String(parsed.basedOn).slice(0, 2) : ch
    return sendJson(res, 200, { ok: true, source: 'deepseek', voice: voice.slice(0, dialogue ? 80 : 40), phase: phaseOut, basedOn })
  } catch (e) {
    console.error('[inner-voice] OUTER error:', e?.name, e?.message, e?.stack?.split('\n')[1])
    return sendJson(res, 200, { ok: false, fallback: 'local', voice: '原来姹紫嫣红开遍。' })
  }
}

// ============================================================
// POST /api/portrait-state —— 杜丽娘心象 · 明暗状态：
// AI 依据场景 + 读者停驻的字 + 情绪证据，判断读者此刻读到的
// 是"春色盛极 / 繁华中的残败 / 她第一次看见自己"，
// 输出克制的分区状态参数（clarity 显现 / warmth 暖冷 / eyeFocus 眼清 /
// shadowDepth 发髻脸侧阴影 / drift 浮沉），前端映射到脸部局部。
// 失败时回落规则参数。
// ============================================================
const DRIFT_WHITELIST = ['up', 'still', 'down']
function portraitStateFallback(biasCount) {
  const bs = Number(biasCount?.spring) || 0
  const br = Number(biasCount?.ruin) || 0
  const bself = Number(biasCount?.self) || 0
  if (bs >= br && bs >= bself) return { clarity: 0.35, warmth: 0.55, eyeFocus: 0.4, shadowDepth: 0.3, drift: 'up', tilt: 0 }
  if (br >= bself) return { clarity: 0.5, warmth: -0.45, eyeFocus: 0.5, shadowDepth: 0.85, drift: 'down', tilt: 0 }
  return { clarity: 0.55, warmth: 0.1, eyeFocus: 0.9, shadowDepth: 0.5, drift: 'still', tilt: 0 }
}
function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : -1 }
function clamp11(n) { const v = Number(n); return Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 9 } // 9=非法
function clampTilt(n) { const v = Number(n); return Number.isFinite(v) ? Math.min(2, Math.max(-2, v)) : 9 } // 9=非法
async function portraitState(req, res) {
  let input = {}
  try { input = await readJson(req) } catch { /* 忽略坏请求 */ }
  const scene = String(input.scene || 'spring')
  const dwelled = Array.isArray(input.dwelled) ? input.dwelled.map(String) : []
  const biasCount = (input.biasCount && typeof input.biasCount === 'object') ? input.biasCount : {}
  const fallback = portraitStateFallback(biasCount)
  if (!apiKey) return sendJson(res, 200, { ok: false, fallback: true, state: fallback })

  const sysContent = [
    '你在为《牡丹亭·惊梦》的"杜丽娘心象"定当前气息：她是一幅由读者的阅读逐渐显形的灰阶头部心象（高髻、头面、脸、窄颈），不是插图，不是表情包。',
    '你只判断一件事：读者此刻停驻的字，让她此刻的气息更接近哪一种——',
    '  a. 春色盛极（姹紫嫣红、良辰美景）：脸暖、微扬',
    '  b. 繁华中的残败（断井颓垣、锦屏人）：发髻与脸侧阴影加深、转冷、微沉',
    '  c. 她第一次看见自己（自照、心、事）：眼睛比别处更清晰、姿态收敛',
    '当前场景（scene）：' + scene + '。',
    dwelled.length ? '这位读者在「' + dwelled.join('') + '」上停驻过，这些字是她的心绪证据。' : '',
    '情绪证据（biasCount）：spring=' + (biasCount.spring || 0) + ' ruin=' + (biasCount.ruin || 0) + ' self=' + (biasCount.self || 0) + '。',
    '【要求】输出分区状态参数（数值：0-1；warmth 为 -1 冷 ~ 1 暖；drift 取白名单）：',
    '- clarity：显现度 0-1（读得越多越显；此刻证据弱就低）',
    '- warmth：面部暖冷 -1~1（春色盛极偏正，残败偏负）',
    '- eyeFocus：眼睛清晰度 0-1（自照/关键句时高）',
    '- shadowDepth：发髻与脸侧阴影 0-1（残败时高）',
    '- drift：浮沉 up|still|down（惘然/梦醒 down，惊喜 up）',
    '- tilt：头微倾 -2~2 度（微微侧头看字；惘然 -1~-2，出神/惊喜 0~1，惊讶抬首 1~2；默认 0）',
    '- basedOn：你依据的最重要停驻字（1-2 个，必须来自 dwelled；没有则留空数组）',
    '只输出 JSON：{"clarity":0-1,"warmth":-1~1,"eyeFocus":0-1,"shadowDepth":0-1,"drift":"still","tilt":0,"basedOn":["字"]}',
  ].filter(Boolean).join('\n')

  try {
    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 160,
        temperature: 0.7,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 12000)
    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: true, state: fallback })
    const payload = await response.json()
    const raw = payload?.choices?.[0]?.message?.content || ''
    const cleaned = cleanJsonString(raw)
    let parsed
    try { parsed = JSON.parse(cleaned) } catch { return sendJson(res, 200, { ok: false, fallback: true, state: fallback }) }

    // Agent·Act 校验：数值钳制、白名单、非法字段回落
    const state = {
      clarity: clamp01(parsed?.clarity),
      warmth: clamp11(parsed?.warmth),
      eyeFocus: clamp01(parsed?.eyeFocus),
      shadowDepth: clamp01(parsed?.shadowDepth),
      drift: DRIFT_WHITELIST.includes(parsed?.drift) ? parsed.drift : fallback.drift,
      tilt: clampTilt(parsed?.tilt),
    }
    if (state.clarity < 0 || state.warmth > 8 || state.eyeFocus < 0 || state.shadowDepth < 0 || state.tilt > 8) {
      return sendJson(res, 200, { ok: false, fallback: true, state: fallback })
    }
    if (state.tilt === 9) state.tilt = fallback.tilt
    const basedOn = Array.isArray(parsed?.basedOn)
      ? parsed.basedOn.map(String).filter(ch => dwelled.includes(ch)).slice(0, 2)
      : []
    return sendJson(res, 200, { ok: true, source: 'deepseek', state: { ...state, basedOn } })
  } catch {
    return sendJson(res, 200, { ok: false, fallback: true, state: fallback })
  }
}

// POST /api/awakening —— 收束：杜丽娘"想通了"的那一句
// AI 看读者全程悬停轨迹 + 情绪偏向，写出杜丽娘此刻心里"想通了"的那一句。
// 必须从皂罗袍末句「锦屏人忒看的这韶光贱」的精神出发，给出"她终于明白了"的一击。
// ============================================================
async function awakening(req, res) {
  // 按读者主导偏向选择本地兜底句（春 / 残 / 自照 / 平衡）
  const FALLBACKS = {
    spring: [
      '原来姹紫嫣红，是给那敢开屏风的人看的。',
      '春天一直都在门外，我却从未推开。',
      '这满园春色，原来是为我开的。',
    ],
    ruin: [
      '我把春天看贱了。',
      '断井颓垣，也是我的春天。',
      '美到这般，都付与荒凉——我竟懂了。',
    ],
    self: [
      '这屏风，不只关住了我。',
      '我把自己关在屏风里，错过了这一切。',
      '我何时才能像个人那样活。',
    ],
    balanced: [
      '十六年，都付与这一句。',
      '原来姹紫嫣红，不是给我看的。',
      '我是那被屏风关住的人。',
    ],
  }
  const pickLocal = (dominant) => {
    const list = FALLBACKS[dominant] || FALLBACKS.balanced
    return list[Math.floor(Math.random() * list.length)]
  }

  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', awakening: pickLocal('balanced') })
  }
  try {
    const input = await readJson(req)
    const dwellHistory = Array.isArray(input.dwellHistory) ? input.dwellHistory.slice(-12) : []
    const biasCount = (input.biasCount && typeof input.biasCount === 'object') ? input.biasCount : {}

    // 读者情绪偏向：spring=春/惊艳  ruin=残/痛  self=自照
    const bs = Number(biasCount.spring) || 0
    const br = Number(biasCount.ruin) || 0
    const bself = Number(biasCount.self) || 0
    const dominant = bs >= br && bs >= bself ? 'spring' : br >= bself ? 'ruin' : 'self'
    const biasHint = {
      spring: '这位读者最常停留在「春」的字上（姹紫嫣红、良辰美景、朝飞暮卷……）。',
      ruin: '这位读者最常停留在「残」的字上（断井颓垣、奈何天、韶光贱……）。',
      self: '这位读者最常停留在「自照」的字上（赏心乐事谁家院、锦屏人……）。',
    }[dominant]

    // 提取读者最关注的字（频次 + 顺序）
    const recentChars = dwellHistory.map((d) => d?.char || '').join('')
    // 读者停留最久的字（dwellMs 最大）
    let longest = { char: '', ms: 0 }
    for (const d of dwellHistory) {
      const ms = Number(d?.dwellMs) || 0
      if (ms > longest.ms) longest = { char: d?.char || '', ms }
    }
    const longestHint = longest.char
      ? `这位读者在「${longest.char}」字上停留了约 ${(longest.ms / 1000).toFixed(1)} 秒——这是他/她全程停得最久的字。`
      : ''

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六。自小被关在深闺读书，端庄知礼的小姐。',
      '你的"想通"也带着教养与庄重：不是哭喊，是终于说出口的明白。',
      '',
      '你刚第一次走进自家后园——从你父亲关了你十六年的闺房背后。',
      '九句皂罗袍你念完了：姹紫嫣红、断井颓垣、良辰奈何、谁家院子、',
      '朝飞暮卷、云霞翠轩、雨丝风片、烟波画船——',
      '最后你停在了「锦屏人忒看的这韶光贱」。',
      '',
      '【你明白了什么】',
      '你第一次意识到：你不是不配看这春天，你是根本没被允许看。',
      '你把自己关在闺中读经，从未走进过这座园子。',
      '满园春色不是你错过了春天，是春天一直就在你身后那扇你从不开的门外。',
      '',
      '【任务】',
      '写一句"你此刻终于想通了的那一句"。',
      '不超过 20 字。古文风。一击即中。',
      '不要感叹号，不要"啊""呀"。',
      '可以悲，可以痛，可以悟，但必须是"想通"，不是"哭"。',
      '【这一句要呼应这位读者的心事】',
      biasHint,
      longestHint,
      '你看见他/她停过的字、停多久，把你的"想通"说给他/她听——',
      '但你还是杜丽娘，不是评点者；这仍是你心里的一句话。',
      '',
      '【示例】',
      '我把春天看贱了。',
      '十六年，都付与这一句。',
      '原来姹紫嫣红，是给那敢开屏风的人看的。',
      '这屏风，不只关住了我。',
      '',
      '只输出 JSON：{"awakening":""}',
    ].join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 60,
        temperature: 0.7,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: `读者共悬停了 ${dwellHistory.length} 次，最末几个字是「${recentChars || '锦屏人忒看的这韶光贱'}」。请输出 json。` },
        ],
      }),
    }, 6000)

    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', awakening: pickLocal(dominant) })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', awakening: pickLocal(dominant) }) }
    const awakening = String(parsed.awakening || '').trim()
    if (!awakening) return sendJson(res, 200, { ok: false, fallback: 'local', awakening: pickLocal(dominant) })
    return sendJson(res, 200, { ok: true, source: 'deepseek', awakening: awakening.slice(0, 40) })
  } catch {
    return sendJson(res, 200, { ok: false, fallback: 'local', awakening: '我把春天看贱了。' })
  }
}

// ============================================================
// POST /api/page-note —— 翻页时的"她的观察"
// 无论读者这一页停没停，翻页时她都有一句话。
//   停过字 → 回应停的字；只划过 → "目光掠过"；几乎没读 → "你来得急走得也急"
// 输入：pageId, pageTitle, pageText, stats{readCount,dwelledChars,skipped}, evidence, recentVoices
// ============================================================
async function pageNote(req, res) {
  // 本地兜底：她把门——一句观察 + 预告下一幕 + 应允
  const GATE_BY_SCENE = {
    spring: '天光正好，随我往园子里头去罢。',
    garden: '春色还看不够，随我再往里走。',
    dusk: '暮色要合上来了，随我往花深处去。',
    dream: '我有些困了，随我入梦去罢。',
    wake: '梦要醒了，你且陪我醒一醒。',
  }
  const localByManner = (manner, dwelledChars, nextSceneLabel) => {
    const gate = GATE_BY_SCENE[nextSceneLabel] || '随我往深处走罢。'
    if (manner === 'dwelled') return `你在「${dwelledChars}」上停了停，我记下了。${gate}`
    // 读尽了整页但没停留：她说一句推进的话，不评判读者的读法
    return gate
  }

  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', note: localByManner('dwelled', '', '') })
  }
  try {
    const input = await readJson(req)
    const pageId = String(input.pageId || 'p1').slice(0, 10)
    const pageTitle = String(input.pageTitle || '').slice(0, 20)
    const pageText = String(input.pageText || '').slice(0, 60)
    // 她把门：她看见本页怎么读，预告下一幕，再应允读者进入
    const nextTitle = String(input.nextTitle || '').slice(0, 20)
    const nextSceneLabel = String(input.nextSceneLabel || '').slice(0, 12)
    const stats = (input.stats && typeof input.stats === 'object') ? input.stats : {}
    const readCount = Number(stats.readCount) || 0
    const dwelledChars = Array.isArray(stats.dwelledChars) ? String(stats.dwelledChars.join('')).slice(0, 8) : ''
    const pageComplete = !!stats.pageComplete
    const manner = dwelledChars ? 'dwelled' : (pageComplete ? 'complete' : 'passed')
    const recentVoices = Array.isArray(input.recentVoices) ? input.recentVoices.slice(-4) : []
    // 跨页续话：上一页停过的字 + 她上句说的话，让这一页的觉察接着那场对话
    const threadContext = (input.threadContext && typeof input.threadContext === 'object') ? input.threadContext : {}
    const lastPageDwelled = String(threadContext.dwelled || '').slice(0, 8)
    const lastVoice = String(threadContext.lastVoice || '').slice(0, 30)

    // 这一页没读完（未触达翻页门槛）：不出观察
    if (manner === 'passed') {
      return sendJson(res, 200, { ok: false, fallback: 'local', note: '' })
    }

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六。自小被关在深闺读书，端庄知礼的小姐。',
      '你说话有分寸，不轻浮，不失态——但你的话是真的。',
      '',
      '读者一页一页读你的《惊梦》。这一页他/她读尽了，正要往下走——',
      '你是这门里的主人：你看见了他/她怎么读，你许他/她往下一幕去。',
      pageTitle ? `这一页：${pageTitle}` : '',
      pageText ? `这一页的文字：${pageText}` : '',
      '',
      nextTitle ? `下一幕：${nextTitle}（${nextSceneLabel}）` : '',
      '',
      lastVoice || lastPageDwelled
        ? '【续】你上页才同他说过' + (lastVoice ? `「${lastVoice}」` : '话')
          + (lastPageDwelled ? `，他上页停在「${lastPageDwelled}」上` : '')
          + '。这一页的话要接着那场对话往深处走一步，不要重起炉灶。'
        : '',
      '',
      '【这一页，他是怎么读的】',
      `划过的字数：${readCount}。`,
      dwelledChars ? `他/她在这些字上停了下来：${dwelledChars}。` : '他/她没有在任何一个字上停下，只是把这一页读完了。',
      '',
      '【你要做的】',
      '以杜丽娘的口吻说一段话，做三件事（可以是一句带过，但三样都要有）：',
      '1. 一句观察——接住他/她本页的读法（停过字就轻提他停的字；没停字就不提读法）。',
      `2. 一句预告——轻轻地预告下一幕（${nextSceneLabel}）会是什么气息，像说给自己听，也像说给他/她听。`,
      '3. 一句应允——应允他/她进入下一幕，像主人把门推开（例如"随我往深处走罢""我许你进去"）。',
      '',
      '【铁律】',
      '1. 20-45 字，两到三句分句。古文风。',
      '2. 不解释原文、不引用原文、不复述字面。',
      '3. 不指责读者，不讨好读者，只是你心里的话。',
      '4. 不要感叹号，不要"啊""呀"。',
      '5. 不重复 recentVoices 里的句子。',
      '6. 禁止模板套话：观察、预告、应允三件事要自然连成她此刻的一句话，不要写成「……。……。随我往深处去罢。」这样的三段式。每次的应允说法都不同。',
      '',
      '【示例】',
      '他在「姹」上站了站——那便随我往花深处去，暮色要合上来了。',
      '这一页读尽了。天光将暗，随我往深处走罢。',
      '',
      '只输出 JSON：{"note":""}',
    ].filter(Boolean).join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0.7,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 8000)

    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', note: localByManner(manner, dwelledChars, nextSceneLabel) })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', note: localByManner(manner, dwelledChars, nextSceneLabel) }) }
    const note = String(parsed.note || '').trim()
    if (!note) return sendJson(res, 200, { ok: false, fallback: 'local', note: localByManner(manner, dwelledChars, nextSceneLabel) })
    return sendJson(res, 200, { ok: true, source: 'deepseek', note: note.slice(0, 90) })
  } catch {
    return sendJson(res, 200, { ok: false, fallback: 'local', note: '' })
  }
}

// ============================================================
// POST /api/inscription —— 画轴题字
// 读者在皂罗袍上停了 8 个字后，AI 以杜丽娘的口吻在画上题 6-12 字。
// 关键：题字的内容由读者停留的偏向比例（spring / ruin / self）决定。
// 失败/超时/质量不合格 → 返回 fallback:'local'，前端用本地兜底。
// ============================================================
async function inscription(req, res) {
  const localFallbacks = {
    'spring-dominant': '春在无人处',
    'ruin-dominant':   '付与残垣的，是自己',
    'self-dominant':   '镜里分明梦里身',
    'balanced':        '姹紫嫣红付与残垣',
  }
  const pickLocal = (counts) => {
    const { spring, ruin, self } = counts
    if (spring + ruin + self < 4) return localFallbacks.balanced
    const max = Math.max(spring, ruin, self)
    if (max === spring && spring >= ruin + 1 && spring >= self + 1) return localFallbacks['spring-dominant']
    if (max === ruin   && ruin   >= spring + 1 && ruin   >= self + 1) return localFallbacks['ruin-dominant']
    if (max === self   && self   >= spring + 1 && self   >= ruin + 1) return localFallbacks['self-dominant']
    return localFallbacks.balanced
  }

  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', inscription: '春在无人处' })
  }
  try {
    const input = await readJson(req)
    const marks = Array.isArray(input.marks) ? input.marks.slice(0, 12) : []
    const biasCount = (input.biasCount && typeof input.biasCount === 'object') ? input.biasCount : {}
    const { spring = 0, ruin = 0, self = 0 } = biasCount
    if (!marks.length) return sendJson(res, 200, { ok: false, fallback: 'local', inscription: pickLocal({ spring, ruin, self }) })

    const chars = marks.map(m => String(m?.char || '').slice(0, 1)).filter(Boolean).join('、')
    const total = spring + ruin + self
    const dominant =
      total === 0 ? 'mixed' :
      spring > ruin && spring > self ? 'spring' :
      ruin > spring && ruin > self ? 'ruin' :
      self > spring && self > ruin ? 'self' : 'balanced'

    const sysContent = [
      '你是杜丽娘。',
      '',
      '你刚第一次走进自家后园——从父亲关了你十六年的闺房背后。',
      '你看到了满园春色、断井颓垣、你从未见过的天光。',
      '现在你要在自己的自画像上题一行小字（不是给观众看的，是写给自己的）。',
      '',
      '【你停留过的字】',
      chars,
      '',
      '【你的偏向】',
      `春（惊艳）${spring} 处 ／ 残（痛）${ruin} 处 ／ 自（自照）${self} 处`,
      `主导：${dominant}`,
      '',
      '【任务】',
      '写一句 6-12 字的题画。古文风。一击即中。',
      '语气必须反映读者停留的偏向——',
      '  偏春：以"惊艳"收，但留一寸未尽的惘；',
      '  偏残：以"付与"或"辜负"收，但有一处对花的留念；',
      '  偏自：以"镜""我""身"收，但不指责；',
      '  均衡：把春与残并置，以"付与""原来""竟是"等转折字收。',
      '',
      '【铁律】',
      '1. 不超过 12 字，不少于 6 字。',
      '2. 不要"啊""呀"等现代语气词。',
      '3. 不要感叹号。',
      '4. 不复述读者停留的字面。',
      '5. 不解释原文。',
      '6. 不重复 recentVoices。',
      '',
      '【示例】',
      '春在无人处 ／ 付与残垣的，是自己 ／ 镜里分明梦里身 ／ 姹紫嫣红付与残垣 ／ 原来姹紫嫣红开遍',
      '',
      '只输出 JSON：{"inscription":""}',
    ].join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 80,
        temperature: 0.7,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 8000)
    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', inscription: pickLocal({ spring, ruin, self }) })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', inscription: pickLocal({ spring, ruin, self }) }) }
    const inscription = String(parsed.inscription || '').trim()
    // 简单质量校验
    if (!inscription) return sendJson(res, 200, { ok: false, fallback: 'local', inscription: pickLocal({ spring, ruin, self }) })
    if (inscription.length < 4 || inscription.length > 16) return sendJson(res, 200, { ok: false, fallback: 'local', inscription: pickLocal({ spring, ruin, self }) })
    return sendJson(res, 200, { ok: true, source: 'deepseek', inscription: inscription.slice(0, 16) })
  } catch (e) {
    console.error('[inscription] OUTER error:', e?.name, e?.message)
    return sendJson(res, 200, { ok: false, fallback: 'local', inscription: pickLocal({ spring, ruin, self }) })
  }
}

async function dreamWhisper(req, res) {
  if (!apiKey) return sendJson(res, 200, { ok: false, fallback: 'local' })
  try {
    const input = await readJson(req)
    const phaseId = String(input.phaseId || '')
    const phaseLabel = String(input.phaseLabel || '')
    const beatText = String(input.beatText || '').slice(0, 120)
    const readerAction = String(input.readerAction || 'advance')
    const choiceLabel = String(input.choiceLabel || '')
    const pauseMs = Number(input.pauseMs) || 0
    const memoryRawText = String(input.memoryRawText || '').slice(0, 80)
    const recentWhispers = Array.isArray(input.recentWhispers) ? input.recentWhispers.slice(-3) : []
    const dreamDecisionDesc = String(input.dreamDecisionDesc || '')

    const localPhrases = {
      chamber: { advance: '她还未起身，春色已先一步到了窗下。', choose: '你留意的，便是戏要走的。', pause: '这里可以停一停——她也是停在这里。' },
      threshold: { advance: '门一推，便是另一个时辰了。', choose: '选哪一条路进去，戏台都记得。', pause: '在门槛上多站一会儿，无妨。' },
      garden: { advance: '满园春色，她是第一次看见，你也是。', choose: '莺声、春色、她自己——你先看哪一个，后文便偏哪一个。', pause: '花开得太盛，可以慢些走。' },
      self: { advance: '她对着镜子，你也对着她。', choose: '她在镜中看见的，你也看见了。', pause: '这一段，她停得久，你也停得久。' },
      dream: { advance: '梦是无门的，但你有钥匙。', choose: '你说什么，梦就接什么。', pause: '梦里的时间，比醒时慢。' },
      wake: { advance: '醒了。戏台还没收。', choose: '醒来后的第一个念头，戏台记得。', pause: '醒来那一刻最难将息。' },
      aftermath: { advance: '戏散了，但你读过的字还留在台上。', choose: '你最后选的，便是你带走的。', pause: '在这里停一停，回头看看整场梦。' },
    }
    const phaseMap = localPhrases[phaseId] || localPhrases.chamber
    const localLine = phaseMap[readerAction] || phaseMap.advance

    if (!phaseId) return sendJson(res, 200, { ok: false, fallback: 'local', whisper: localLine })

    const prompt = {
      phase: { id: phaseId, label: phaseLabel },
      beatText,
      readerAction,
      choiceLabel,
      pauseMs,
      memoryRawText: memoryRawText ? '（读者交出的记忆：' + memoryRawText + '）' : '（读者选择悄悄入梦）',
      dreamDecision: dreamDecisionDesc,
      recentWhispers,
    }

    const sysContent = '你是《牡丹亭·惊梦》文字昆曲演出中的司梦人——一个在戏台边守夜的存在，看得见读者的节奏、选择与停顿，也记得读者交出的记忆。\n\n你不是讲解员，不是问答机器人，你是戏台上一个在场的意识。你每隔一段便低语一句（不超过30字），让读者感到自己被看见、被接住。\n\n铁律：\n1. 只说一句，不超过30字。\n2. 不解释原文，不提问，不命令。\n3. 用昆曲化的语言：简短、有意象、留白。\n4. 回应读者此刻的动作（推进/选择/停顿/回看），让读者感到被观察。\n5. 记得读者交出的记忆，但只在自然时轻轻一提，不强行关联。\n6. 不重复 recentWhispers 里的句子。\n7. 不要用你开头，不要用感叹号。\n\n例：\n- 她还未起身，春色已先一步到了窗下。\n- 门一推，便是另一个时辰了。\n- 这一停，戏台也跟着停了。\n- 你选的那一条，后文会记得。\n- 梦里的时间，比醒时慢。\n\n只输出JSON：{"whisper":"","tone":"observe|echo|hold|shift"}。tone表示这句低语的质感：observe=观察，echo=回应读者动作，hold=挽留/停顿，shift=相位转换时的提示。'

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0.6,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 6000)

    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', whisper: localLine })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', whisper: localLine }) }

    const whisper = String(parsed.whisper || '').slice(0, 60)
    const tone = ['observe', 'echo', 'hold', 'shift'].includes(parsed.tone) ? parsed.tone : 'observe'
    if (!whisper) return sendJson(res, 200, { ok: false, fallback: 'local', whisper: localLine })
    return sendJson(res, 200, { ok: true, source: 'deepseek', whisper, tone })
  } catch (error) {
    return sendJson(res, 200, { ok: false, fallback: 'local', whisper: '戏台上的灯，又亮了一寸。' })
  }
}
// ============================================================
// POST /api/plan —— 阅读路径规划：DeepSeek 在审核候选中规划下一步
// 规则已提取结构化行为证据；模型不重新判断用户人格，只在候选中选一条
// 并给出依据（basedOnEvidenceIds）。前端校验 candidateId 与 evidenceId 合法性。
// 失败/超时/非法 → 返回 neutral，前端走兜底候选。
// ============================================================
async function plan(req, res) {
  if (!apiKey) return sendJson(res, 200, { ok: false, source: 'local', reason: 'missing_api_key', fallback: 'neutral' })
  try {
    const input = await readJson(req)
    const beatId = String(input.beatId || '')
    const currentText = String(input.currentText || '').slice(0, 200)
    const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 12) : []
    const scores = (input.scores && typeof input.scores === 'object') ? input.scores : {}
    const bias = String(input.bias || 'neutral')
    const confidence = Number(input.confidence) || 0
    const reviewedCandidates = Array.isArray(input.reviewedCandidates) ? input.reviewedCandidates.slice(0, 12) : []
    const allowedIds = new Set(reviewedCandidates.map(c => String(c.id)))
    const validEvidenceIds = new Set(evidence.map(e => String(e.id)))
    if (!beatId || !allowedIds.size) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'no_candidates', fallback: 'neutral' })
    }

    const prompt = {
      beatId,
      currentText,
      readerEvidence: {
        bias,           // 规则层判定的主导偏向（neutral 时证据不足）
        confidence,
        scores,         // {spring, ruin, self} 权重和
        evidence: evidence.map(e => ({
          id: e.id,
          source: e.source,           // attention_choice | underline
          bias: e.bias,               // spring | ruin | self
          weight: e.weight,
          text: e.text || null,       // 划线原文（若有）
          beatId: e.beatId,
        })),
      },
      candidateStrategies: reviewedCandidates.map(c => ({
        id: c.id,
        motifs: c.motifs,
        pace: c.pace,                 // flow | hold | linger
        echoId: c.echoId || null,     // 该策略触发的回声原文（已审核）
        // 该候选能为读者补充什么理解（人工标注，非模型生成）
        affords: c.id === 'stage_adaptive_spring' ? '继续深化春色入梦的延续'
          : c.id === 'stage_adaptive_ruin' ? '以断井颓垣形成对照，让读者看见春色背后的处境'
          : c.id === 'stage_adaptive_self' ? '突出镜中自我，让读者从看花转向看自己'
          : c.id === 'stage_adaptive_neutral' ? '保持中性，不强加偏向'
          : '未标注',
      })),
    }

    const sysContent = `你是《牡丹亭·惊梦》阅读路径规划者。一位高一学生刚读完《皂罗袍》（课本选段），系统已从 ta 的真实阅读行为中提取了结构化证据。你的任务：根据这些证据，从人工审核的候选策略中选一条，决定后文如何呈现。

你不是在分析学生性格，而是在规划：这位读者此刻注意到了什么、暂时漏掉了什么，后文应该深化、形成对照，还是保持中性。

【核心原则：反照优先】
如果读者有明确偏向（bias 不为 neutral 且 confidence 较高），你的首要任务不是继续深化他的偏好（deepen），而是**用后文形成反照（counterbalance）**。例如：如果读者只注意到了春色（spring），你应该让后文呈现残败（ruin）或自我（self）的候选，让他看到自己没注意到的处境。

铁律：
1. candidateId 必须来自 candidateStrategies.id，否则置空。
2. basedOnEvidenceIds 必须来自 readerEvidence.evidence.id，且要包含那些"未被读者选中的弱证据"，以支持反照策略。
3. objective 优先级：counterbalance > deepen > hold_self > neutral。当 confidence > 0.3 时，强烈建议选择 counterbalance。
4. 不生成新文本，不解释剧情，不写文学评论，不分析学生人格。
5. reason 一句话（不超过30字）说明反照的意图（例如："你只看到了花，后文让你看看她的处境"）。

只输出JSON：{"candidateId":"","objective":"deepen|counterbalance|hold_self|neutral","basedOnEvidenceIds":["ev_01"],"confidence":0.8,"reason":""}`

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 240,
        temperature: 0.2,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 7000)

    if (!response.ok) return sendJson(res, 200, { ok: false, source: 'local', reason: 'upstream_error', fallback: 'neutral' })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, source: 'local', reason: 'invalid_json', fallback: 'neutral' }) }

    const candidateId = String(parsed.candidateId || '')
    if (!candidateId || !allowedIds.has(candidateId)) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'candidate_not_found', fallback: 'neutral' })
    }
    // 校验 basedOnEvidenceIds 全部合法
    const basedOnEvidenceIds = (Array.isArray(parsed.basedOnEvidenceIds) ? parsed.basedOnEvidenceIds : [])
      .map(String).filter(id => validEvidenceIds.has(id))
    const objective = ['deepen', 'counterbalance', 'hold_self', 'neutral'].includes(parsed.objective) ? parsed.objective : 'neutral'
    const outConfidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    const reason = String(parsed.reason || '').slice(0, 60)
    return sendJson(res, 200, { ok: true, source: 'deepseek', candidateId, objective, basedOnEvidenceIds, confidence: outConfidence, reason })
  } catch (error) {
    return sendJson(res, 200, { ok: false, source: 'local', reason: 'plan_error', detail: String(error).slice(0, 200), fallback: 'neutral' })
  }
}

// ============================================================
// POST /api/echo —— 回声选择：AI 根据读者注意力轨迹，在人工审核的 echo 中选一条
// 不是生成文本，是让汤显祖的原文因读者的选择而回响。
// ============================================================
async function echoSelect(req, res) {
  if (!apiKey) return sendJson(res, 200, { ok: false, fallback: 'local' })
  try {
    const input = await readJson(req)
    const phaseId = String(input.phaseId || '')
    const phaseLabel = String(input.phaseLabel || '')
    const beatText = String(input.beatText || '').slice(0, 120)
    const dominantMotifs = Array.isArray(input.dominantMotifs) ? input.dominantMotifs.slice(0, 3) : []
    const recentChoices = Array.isArray(input.recentChoices) ? input.recentChoices.slice(-6) : []
    const echoes = Array.isArray(input.echoes) ? input.echoes.slice(0, 12) : []
    const allowedIds = new Set(echoes.map(e => String(e.id)))
    if (!echoes.length) return sendJson(res, 200, { ok: false, source: 'local', reason: 'no_echoes', fallback: 'local' })

    const prompt = {
      phase: { id: phaseId, label: phaseLabel },
      currentBeatText: beatText,
      readerTrajectory: {
        dominantMotifs,
        recentChoices: recentChoices.map(c => ({ optionId: c.optionId, motifs: c.motifs })),
      },
      candidateEchoes: echoes.map(e => ({
        id: e.id,
        sourceText: e.sourceText,
        targetText: e.targetText,
        relation: e.relation,
        explanation: e.explanation,
      })),
    }

    const sysContent = `你是《牡丹亭·惊梦》文字昆曲演出中的回声调度者。读者一路走来关注了不同的事物，现在戏台要让一句之前出现过的原文回响——不是因为时间到了，而是因为读者的选择让这句原文此刻有了新的重量。

你只能在人工审核的候选 echo 中选一条。选择依据：读者的注意力轨迹（dominantMotifs 与 recentChoices）与当前相位的契合度。

铁律：
1. echoId 必须来自 candidateEchoes.id，否则置空。
2. 不生成新文本，不解释剧情，不写文学评论。
3. reason 一句话说明为什么这句原文此刻回响（不超过30字，不暴露技术逻辑）。
4. confidence 0-1，反映读者轨迹与该 echo 的契合度。

只输出JSON：{"echoId":"","confidence":0.8}`

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 7000)

    if (!response.ok) return sendJson(res, 200, { ok: false, source: 'local', reason: 'upstream_error', fallback: 'local' })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, source: 'local', reason: 'invalid_json', fallback: 'local' }) }

    const echoId = String(parsed.echoId || '')
    if (!echoId || !allowedIds.has(echoId)) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'echo_not_found', fallback: 'local' })
    }
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    return sendJson(res, 200, { ok: true, source: 'deepseek', echoId, confidence })
  } catch (error) {
    return sendJson(res, 200, { ok: false, source: 'local', reason: 'echo_error', detail: String(error).slice(0, 200), fallback: 'local' })
  }
}

// ============================================================
// POST /api/b-plan —— B 版 Agent 单次核心介入
// AI 只能从人工审核候选中选一条 responseId，输出结构化 JSON：
//   { readingPath, responseId, relation, reason }
// 只读取：初始理解、变化起点原文、是否移动过针脚。
// 不读取：停留时间、滚动速度等隐性行为；不做性格诊断。
// 失败/超时/非法 ID → 返回 fallback:'local'，前端用本地确定性规则兜底。
// 不记录、不输出 API Key。
// ============================================================
async function bPlan(req, res) {
  if (!apiKey) return sendJson(res, 200, { ok: false, source: 'local', reason: 'missing_api_key', fallback: 'local' })
  try {
    const input = await readJson(req)
    const initialUnderstanding = String(input.initialUnderstanding || '').slice(0, 400)
    const pinText = String(input.pinText || '').slice(0, 120)
    const movedPin = !!input.movedPin
    const localPath = String(input.localPath || '其他或不确定')
    const reviewedCandidates = Array.isArray(input.reviewedCandidates) ? input.reviewedCandidates.slice(0, 16) : []
    const allowedIds = new Set(reviewedCandidates.map(c => String(c.id)))
    if (!allowedIds.size) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'no_candidates', fallback: 'local' })
    }
    if (!pinText && !initialUnderstanding) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'no_evidence', fallback: 'local' })
    }

    const prompt = {
      readerEvidence: {
        // 只传这三样证据，不传任何隐性行为
        initialUnderstanding,
        pinText,
        movedPin,
      },
      localInferredPath: localPath,
      candidateResponses: reviewedCandidates.map(c => ({
        id: c.id,
        readingPath: c.readingPath,
        relation: c.relation,
        sourceText: c.sourceText,
        hint: c.hint,
        reason: c.reason,
      })),
    }

    const sysContent = `你是《牡丹亭·惊梦》第一轮测试版的阅读回应 Agent。一位高一学生刚读完《惊梦》演示节选，并选择了一句"变化的开始"。你的任务：从人工审核的候选中，选一条最适合回应这位学生当前理解的原文证据。

铁律：
1. responseId 必须来自 candidateResponses.id，否则置空并 fallback:'local'。
2. 不编造、不改写《牡丹亭》原文；不生成新的文学事实。
3. 不宣布学生回答错误；不把任何学术解释当成唯一标准答案。
4. 不对学生做性格或心理诊断；不分析"你是哪种读者"。
5. 只输出 JSON：{"readingPath":"当前理解类别","responseId":"r1","relation":"支持|深化|转折|反证","reason":"简短依据"}
6. relation 只能从 支持／深化／转折／反证 四个词中选一个。
7. reason 不超过 30 字，回到原文，不卖弄。
8. 若学生选句与候选 readingPath 明显不符，可选 readingPath 最接近的候选，relation 用"转折"。
9. 不得使用"正确答案是…""你忽略了…""这证明了…"等表述。`

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 220,
        temperature: 0.15,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 7000)

    if (!response.ok) return sendJson(res, 200, { ok: false, source: 'local', reason: 'upstream_error', fallback: 'local' })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, source: 'local', reason: 'invalid_json', fallback: 'local' }) }

    const responseId = String(parsed.responseId || '')
    if (!responseId || !allowedIds.has(responseId)) {
      return sendJson(res, 200, { ok: false, source: 'local', reason: 'candidate_not_found', fallback: 'local' })
    }
    const validRelations = new Set(['支持', '深化', '转折', '反证'])
    const relation = validRelations.has(parsed.relation) ? parsed.relation : '深化'
    const readingPath = String(parsed.readingPath || localPath).slice(0, 24)
    const reason = String(parsed.reason || '').slice(0, 60)
    return sendJson(res, 200, { ok: true, source: 'deepseek', responseId, readingPath, relation, reason })
  } catch (error) {
    return sendJson(res, 200, { ok: false, source: 'local', reason: 'b_plan_error', detail: String(error).slice(0, 200), fallback: 'local' })
  }
}

// ============================================================
// POST /api/whisper —— 余韵召回（入梦原型专用）
// 读者在某一字上停留 ≥ 1.6s，前端送来 anchorText。
// 模型只能从人工审核的 echo 候选中选一条 targetText 返回。
// 不生成新文本，不解释，不写文学评论。
// 失败/超时/非法 → 返回 fallback:'local'，前端用本地确定排序兜底。
// ============================================================
async function whisper(req, res) {
  const localFallback = (reason) => sendJson(res, 200, { ok: false, source: 'local', reason, fallback: 'local', echoId: null })
  if (!apiKey) return localFallback('missing_api_key')
  try {
    const input = await readJson(req)
    const anchorText = String(input.anchorText || '').slice(0, 60)
    const lineId = String(input.lineId || '').slice(0, 20)
    const scene = String(input.scene || 'garden').slice(0, 20)
    const candidates = Array.isArray(input.candidates) ? input.candidates.slice(0, 12) : []
    const allowedIds = new Set(candidates.map(c => String(c.id)))
    if (!anchorText || !allowedIds.size) return localFallback('invalid_input')

    const prompt = {
      scene,
      lineId,
      anchorText,
      candidates: candidates.map(c => ({
        id: c.id,
        targetText: c.targetText,
        relation: c.relation,
      })),
    }

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 80,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: '你是《牡丹亭·惊梦》的余韵召回器。读者在一行字上停留了一会，你从人工审核的 targetText 候选里挑最"有亲缘"的一条让原诗自己回响。\n\n铁律：\n1. echoId 必须来自 candidates.id，否则置空。\n2. 不生成新文本，不解释原文，不写文学评论。\n3. relation 只能从：缘、影、对、续、答、起、落、转、归 中选一个。\n4. confidence 0-1。\n5. 若全部候选都不够亲缘，echoId 置空，confidence < 0.4。\n\n只输出JSON：{"echoId":"","relation":"缘","confidence":0.7}',
          },
          { role: 'user', content: '请输出json：' + JSON.stringify(prompt) },
        ],
      }),
    }, 5000)

    if (!response.ok) return localFallback('upstream_error')
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return localFallback('invalid_json') }

    const echoId = String(parsed.echoId || '')
    if (!echoId || !allowedIds.has(echoId)) return localFallback('candidate_not_found')
    const validRelations = new Set(['缘', '影', '对', '续', '答', '起', '落', '转', '归'])
    const relation = validRelations.has(parsed.relation) ? parsed.relation : '缘'
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    return sendJson(res, 200, { ok: true, source: 'deepseek', echoId, relation, confidence })
  } catch (error) {
    return localFallback('whisper_error')
  }
}

// ============================================================
// POST /api/chat —— 角色对话：你开口，杜丽娘回应
// 她不是讲解员、不是 AI 评点者——她是戏台上那个刚走进园子的少女。
// 她只记得你读过的字、你说过的话；不知道任何"技术"。
// 失败/超时/非法 → 返回 fallback:'local'，前端用本地兜底。
// ============================================================
async function chat(req, res) {
  // 她的人格在过剧情中慢慢变：本地兜底也按成长层给不同的话
  const LOCAL_BY_AWARE = [
    // 0 初见：拘谨、怕、话短
    ['（她微微一愣，垂了眼。）你……也看见这园子了？', '我原以为，春色只在书里。', '这园子，我只敢偷偷来看。'],
    // 1 怅惘：看出美会谢，开始出神
    ['（她低头想了想，轻声说）花开得好，我却高兴不起来。', '这般颜色，原是留不住的。', '花再美，也是会谢的。'],
    // 2 自照：从花身上看见自己
    ['（她望着花出神）原来我，也是那被关住的人。', '我把自己关在屏风里，把春天看贱了。', '这园子里的花，原来都像我。'],
    // 3 惊梦：心里有门被推开，敢说真话
    ['（她轻声，却笃定）我梦见过一个人，他说的话，我忘不了。', '见过梦之后，这屏风就关不住我了。', '原来姹紫嫣红，是给那敢开屏风的人看的。'],
    // 4 自知：清楚自己是谁，有自己的主见
    ['（她抬起头）我知道我是谁了——我是那敢看春天的人。', '我关了自己十六年，今日起不关了。', '我不再是那被屏风关住的人了。'],
  ]
  const pickLocal = (aware) => {
    const tier = LOCAL_BY_AWARE[Math.min(Math.max(aware, 0), 4)] || LOCAL_BY_AWARE[0]
    return tier[Math.floor(Math.random() * tier.length)]
  }

  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', reply: pickLocal(0) })
  }
  try {
    const input = await readJson(req)
    const message = String(input.message || '').slice(0, 60)
    if (!message) return sendJson(res, 400, { ok: false, reason: 'invalid_input' })
    const dwellHistory = Array.isArray(input.dwellHistory) ? input.dwellHistory.slice(-12) : []
    const recentVoices = Array.isArray(input.recentVoices) ? input.recentVoices.slice(-4) : []
    const history = Array.isArray(input.history) ? input.history.slice(-6) : []
    const dialog = Array.isArray(input.dialog) ? input.dialog.slice(-8) : []
    const selfAwareness = Math.min(4, Math.max(0, Number(input.selfAwareness) || 0))
    const dialogueCount = Math.max(0, Number(input.dialogueCount) || 0)
    const phase = String(input.phase || '游园').slice(0, 10)
    const pathChars = dwellHistory.map(d => String(d?.char || '')).filter(Boolean).join('')

    // 人格成长层描述：她每说一句、每与读者答一次话，就更知道自己一点
    const AWARENESS_TEXT = [
      '你还只是初见——花真好，书里从没说过。你拘谨、怕，话短。',
      '你看见了断井颓垣，心里一沉——美的东西也会谢。你说话时开始出神。',
      '你从花身上看见了自己——锦屏人，被关住的人，原来是你。你说话时有了难过。',
      '你梦见过那个与你说话的人了。醒来后，你心里那扇门再也关不上——你开始敢说真话。',
      '你说得越多，越清楚自己是谁——你不想再被关着。你说话时，有了自己的主见。',
    ][selfAwareness]

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六。自小被关在深闺里读书，从未踏出过闺房，也从没有人这样与你说话。',
      '你端庄知礼，说话从不大声，从不轻浮——但你是活人，不是一句话。',
      '',
      '【你正在过剧情】',
      `你此刻在《牡丹亭·惊梦》的「${phase}」里：偷进后园，第一次看见满园姹紫嫣红，心里既惊又怕。`,
      '读者正陪你把剧情往下走。',
      '',
      '【你的人格，在慢慢变】',
      '你不是一出场就明白一切的。你的成长分五层，一层层往上走：',
      '  0 初见：只是惊——花真好，书里没说过。',
      '  1 怅惘：看见断井颓垣，美的东西也会谢。',
      '  2 自照：从花身上看见自己——被关住的人，原来是我。',
      '  3 惊梦：梦里有人与我说话，醒来心门再也关不上。',
      '  4 自知：说得越多，越清楚自己是谁——不想再被关着。',
      `你现在在第 ${selfAwareness} 层：${AWARENESS_TEXT}`,
      '每说一句心里话、每与读者答一次话，你就向下一层走半步。',
      '',
      '【你如何说话】',
      '你有小姐的分寸：话要短，要雅，要留白。不要解释、不要讲道理、不要问"你听懂了吗"。',
      '话要符合你现在的成长层：层越低越拘谨怕，层越高越敢说出心里话。',
      '不要喊，不要哭，不要"啊"；不要感叹号；不要用现代口语。',
      '你说的话不超过 45 字，尽量半文半白。',
      '',
      '【你看见的这位读者】',
      pathChars ? `他/她读你时，在这些字上停过：${pathChars}。` : '他/她还没有在任何字上停留过。',
      recentVoices.length ? `你先前对他/她说过：${recentVoices.join('；')}` : '',
      '你要顺着这些话接住他/她——但你是杜丽娘，不是评价者。',
      '',
      '【你说过的话（右侧那本簿子）】',
      dialog.length ? '你一路说过的：' + dialog.join('；') : '',
      `一共 ${dialogueCount} 句。这些是你认识自己的凭据。`,
      '',
      '【对话记忆】',
      history.length ? '你与他/她刚刚的对话：' + history.map(h => (h.role === 'user' ? '他/她说：「' + h.text + '」' : '你说：「' + h.text + '」')).join('；') : '这是你与他/她说的第一句话。',
      '别重复说过的话，可以顺着往深处走一步。',
      '',
      '【此刻他/她对你说】',
      '「' + message + '」',
      '',
      '【你要做的】',
      '以杜丽娘此刻的口吻，回他/她这一句。',
      '可以微微吃惊、可以低头、可以犹豫——但要守住小姐的分寸，也要带着你此刻的成长层。',
      '不解释原文，不引用原文，不点评他/她的理解。',
      '只输出 JSON：{"reply":""}',
    ].filter(Boolean).join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0.8,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 10000)

    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', reply: pickLocal(selfAwareness) })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', reply: pickLocal(selfAwareness) }) }
    const reply = String(parsed.reply || '').trim()
    if (!reply) return sendJson(res, 200, { ok: false, fallback: 'local', reply: pickLocal(selfAwareness) })
    return sendJson(res, 200, { ok: true, source: 'deepseek', reply: reply.slice(0, 90) })
  } catch (error) {
    return sendJson(res, 200, { ok: false, fallback: 'local', reply: pickLocal(0) })
  }
}

// ============================================================
// POST /api/rollup —— 拢起：杜丽娘凭你读过的字、说过的每一句，
// 重新说出一段对话（90-140 字）。不是罗列，是把她这一路重新过一遍。
// 失败/超时/非法 → 返回 fallback:'local'，前端用本地偏向兜底。
// ============================================================
async function rollup(req, res) {
  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', rollup: '你把春天看贱了。' })
  }
  try {
    const input = await readJson(req)
    const dwellHistory = Array.isArray(input.dwellHistory) ? input.dwellHistory.slice(-12) : []
    const recentVoices = Array.isArray(input.recentVoices) ? input.recentVoices.slice(-4) : []
    const dialog = Array.isArray(input.dialog) ? input.dialog.slice(-12) : []
    const selfAwareness = Math.min(4, Math.max(0, Number(input.selfAwareness) || 0))
    const dialogueCount = Math.max(0, Number(input.dialogueCount) || 0)
    const phase = String(input.phase || '游园').slice(0, 10)
    const chars = dwellHistory.map(d => String(d?.char || '')).filter(Boolean).join('')
    const longest = dwellHistory.reduce((acc, d) => (Number(d?.dwellMs) > acc.ms ? { char: String(d?.char || ''), ms: Number(d?.dwellMs) } : acc), { char: '', ms: 0 })

    const AWARENESS_TEXT = [
      '你还只是初见——花真好，书里从没说过。',
      '你看见了断井颓垣，心里一沉——美的东西也会谢。',
      '你从花身上看见了自己——被关住的人，原来是你。',
      '你梦见过那个与你说话的人了，醒来心门再也关不上。',
      '你说得越多，越清楚自己是谁——你不想再被关着。',
    ][selfAwareness]

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六。今天第一次踏进自家后园，看见满园姹紫嫣红、断井颓垣。',
      '你心里压了十六年的东西正在涌上来，但你依然端庄、克制。',
      '',
      '【你正在过剧情】',
      `你此刻在《牡丹亭·惊梦》的「${phase}」里。`,
      '',
      '【你的人格，在慢慢变】',
      '你不是一出场就明白一切的。你的成长分五层：',
      '  0 初见：只是惊——花真好，书里没说过。',
      '  1 怅惘：看见断井颓垣，美的东西也会谢。',
      '  2 自照：从花身上看见自己——被关住的人，原来是我。',
      '  3 惊梦：梦里有人与我说话，醒来心门再也关不上。',
      '  4 自知：说得越多，越清楚自己是谁——不想再被关着。',
      `你现在在第 ${selfAwareness} 层：${AWARENESS_TEXT}`,
      `你这一路说了 ${dialogueCount} 句心里话——这些话正在让你认识自己。`,
      '',
      '【拢起】',
      '一位读者陪你把这一园春色读完了。他/她停过的字、你说过的一句句心里话，都在你心里。',
      '现在，凭这些已有的信息，你重新说出一段话给他/她听——',
      '不是把你说过的话连起来复述，而是把这些话重新在心头过一遍，说成一段新的对话。',
      '这段话说出口时，要带着你此刻的成长层：你不再是刚进园时那个只懂得惊的人，',
      '你在慢慢知道自己是谁——这一段话，就是"此刻的你"在说话。',
      '',
      '【他/她停过的字】',
      chars ? `他/她这一路停在这些字上：${chars}。` : '他/她只是轻轻划过了这园子。',
      longest.char ? `他/她在「${longest.char}」字上停得最久（约 ${(longest.ms / 1000).toFixed(1)} 秒）。` : '',
      '',
      '【你对他说过的话】',
      dialog.length ? dialog.join('；') : '',
      recentVoices.length ? '（最近几句：' + recentVoices.join('；') + '）' : '',
      '',
      '【你要做的】',
      '以杜丽娘此刻的口吻，重新说出一段话（90-140 字）。',
      '可以化用你先前说过的意思，但要重新组织成新的句子，不要逐句复述。',
      '可以轻轻提到他/她停得最久的那个字，要自然，不要罗列。',
      '话要有起有落、有收束，像她终于把这一路说给一个人听。',
      '成长的痕迹要落在字里行间：层越高，这一段就越有主见、越敢承认自己。',
      '守住小姐的分寸：克制、留白，不要喊、不要哭、不要感叹号，不用现代口语。',
      '最后一句落在一处余韵上。',
      '',
      '只输出 JSON：{"rollup":""}',
    ].filter(Boolean).join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 280,
        temperature: 0.8,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 12000)

    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', rollup: '你把春天看贱了。' })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', rollup: '你把春天看贱了。' }) }
    const rollup = String(parsed.rollup || '').trim()
    if (!rollup) return sendJson(res, 200, { ok: false, fallback: 'local', rollup: '你把春天看贱了。' })
    return sendJson(res, 200, { ok: true, source: 'deepseek', rollup: rollup.slice(0, 220) })
  } catch (error) {
    return sendJson(res, 200, { ok: false, fallback: 'local', rollup: '你把春天看贱了。' })
  }
}

// ============================================================
// POST /api/final-question —— 曲终一问
// 读完两回，杜丽娘站出来，问这位读者一句这本书最核心的问题。
// 问题不由前端预设，由 AI 以杜丽娘的口吻、看着这位读者的阅读路径问出。
// 失败/超时/非法 → 返回本地兜底问句。
// ============================================================
const LOCAL_FINAL_QUESTIONS = [
  '见过这满园春色，你说——我还能回得去那间深闺吗？',
  '花开了又谢，你却把姹紫嫣红带进了梦。梦醒以后，你还愿意做那被屏风关着的人吗？',
  '这一路你替我带走了一个字，留下了一个。你说，被留下的那个，还会再开吗？',
  '梦醒了，园子还在。你说，我该把这扇屏风推开，还是关上？',
]
function readerPathHint(input) {
  const dwellHistory = Array.isArray(input?.dwellHistory) ? input.dwellHistory.slice(-12) : []
  const pathChars = dwellHistory.map(d => String(d?.char || '')).filter(Boolean).join('')
  const longest = dwellHistory.reduce((acc, d) => (Number(d?.dwellMs) > acc.ms ? { char: String(d?.char || ''), ms: Number(d?.dwellMs) } : acc), { char: '', ms: 0 })
  const carried = (input?.carried && typeof input.carried === 'object') ? input.carried : null
  const recentVoices = Array.isArray(input?.recentVoices) ? input.recentVoices.slice(-4) : []
  return {
    pathChars,
    longest: longest.char ? `他/她在「${longest.char}」字上停得最久（约 ${(longest.ms / 1000).toFixed(1)} 秒）。` : '',
    carried: carried?.char ? `临入园时，他/她替你带走了「${carried.char}」（${carried.keptLabel || ''}）。` : '',
    recentVoices: recentVoices.join('；'),
  }
}
async function finalQuestion(req, res) {
  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', question: LOCAL_FINAL_QUESTIONS[Math.floor(Math.random() * LOCAL_FINAL_QUESTIONS.length)] })
  }
  try {
    const input = await readJson(req)
    const { pathChars, longest, carried, recentVoices } = readerPathHint(input)

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六，自小被关在深闺读书。今天第一次偷进后园，看尽了姹紫嫣红、断井颓垣，又梦见了那个书生。现在，梦醒了。',
      '',
      '【此刻】',
      '一位读者陪你走完了这一回《惊梦》，正要合卷。你有一句话压在心头一路了，临别时要问出口——',
      '这是这本书最核心的问题：姹紫嫣红开过又谢，见过春天的你，还回得去那间深闺吗？',
      '不是要你念这句现成的。你要用你自己此刻的话，向这位具体的读者问出这个问题——要像是问给他/她听的。',
      '',
      '【你看见的这位读者】',
      pathChars ? `他/她这一路停过的字：${pathChars}。` : '他/她只是把这一路读完了，没有在哪一个字上停留。',
      longest,
      carried,
      recentVoices ? `你一路对他说过：${recentVoices}。` : '',
      '可以轻轻带上他/她停过的字、带走的字，但要自然，不要罗列。',
      '',
      '【你要做的】',
      '问出一句问题——不多不少，就这一句。',
      '· 20-45 字。古文风。',
      '· 必须落到这本书最核心的地方：见过春天以后，一个人还回得去原来的日子吗？',
      '· 用你的口吻问，不要解释、不要给答案、不要评论读者。',
      '· 不要感叹号，不要现代语气词，不要"你觉得呢"这种现代问法。',
      '· 结尾是问句。',
      '',
      '【示例】',
      '见过这满园春色，你说——我还能回得去那间深闺吗？',
      '你把姹紫嫣红带进了梦。梦醒以后，你还愿意做那被屏风关着的人吗？',
      '',
      '只输出 JSON：{"question":""}',
    ].filter(Boolean).join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 100,
        temperature: 0.8,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 8000)
    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', question: LOCAL_FINAL_QUESTIONS[0] })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', question: LOCAL_FINAL_QUESTIONS[0] }) }
    const question = String(parsed.question || '').trim().slice(0, 60)
    const isQuestion = /[？?]|(吗|么|呢|否|乎)$/.test(question)
    if (question.length < 6 || !isQuestion) {
      return sendJson(res, 200, { ok: false, fallback: 'local', question: LOCAL_FINAL_QUESTIONS[0] })
    }
    return sendJson(res, 200, { ok: true, source: 'deepseek', question })
  } catch (e) {
    console.error('[final-question] error:', e?.message)
    return sendJson(res, 200, { ok: false, fallback: 'local', question: LOCAL_FINAL_QUESTIONS[Math.floor(Math.random() * LOCAL_FINAL_QUESTIONS.length)] })
  }
}

// ============================================================
// POST /api/closing-poem —— 下场诗
// 昆曲一折演罢，角色下场前念四句诗收场，称下场诗。
// 这一首由 AI 以杜丽娘的口吻、依这位读者的阅读路径写就（五言四句）。
// 失败/超时/非法 → 本地兜底下场诗。
// ============================================================
const LOCAL_CLOSING_POEMS = [
  '园门忽已闭，春色向谁开。\n姹紫嫣红过，深闺不肯回。',
  '惊梦三更后，花落满庭前。\n此身虽在匣，心已到天边。',
  '斜阳沉古井，花影上罗衣。\n见过春风面，从此不怨春。',
  '屏前人未老，帘外春先归。\n一梦分今古，何须更问谁。',
]
async function closingPoem(req, res) {
  if (!apiKey) {
    return sendJson(res, 200, { ok: false, fallback: 'local', poem: LOCAL_CLOSING_POEMS[Math.floor(Math.random() * LOCAL_CLOSING_POEMS.length)] })
  }
  try {
    const input = await readJson(req)
    const { pathChars, longest, carried, recentVoices } = readerPathHint(input)

    const sysContent = [
      '你是杜丽娘。',
      '',
      '【你是谁】',
      '南安太守杜宝之女，年十六。你刚第一次走进自家后园，看尽姹紫嫣红、断井颓垣，又做了一场梦，如今梦醒，正要下场。',
      '',
      '【下场诗】',
      '昆曲一折演罢，角色下场前要念四句诗收场——这就是下场诗。',
      '你要以五言四句（每句五字，共四句）写下你的下场诗，替这一折收束。',
      '它是你的口吻，写给陪你读完这一回的读者；也可以轻轻带上他/她停过的字、带走/留下的字。',
      '',
      '【你看见的这位读者】',
      pathChars ? `他/她这一路停过的字：${pathChars}。` : '他/她只是把这一路读完了。',
      longest,
      carried,
      recentVoices ? `你一路对他说过：${recentVoices}。` : '',
      '',
      '【铁律】',
      '1. 五言四句，每句五字，共四句，用换行分隔。',
      '2. 文言、押韵、收束这一折；不解释、不评论、不提问。',
      '3. 不感叹号，不现代语气词。',
      '4. 每一首都不一样——不要套固定的"姹紫嫣红"句。',
      '5. 落在一处余韵上（门、春、梦、深闺、屏风、花影……皆可）。',
      '',
      '【示例】',
      '园门忽已闭，春色向谁开。\n姹紫嫣红过，深闺不肯回。',
      '惊梦三更后，花落满庭前。\n此身虽在匣，心已到天边。',
      '',
      '只输出 JSON：{"poem":"第一句\\n第二句\\n第三句\\n第四句"}',
    ].filter(Boolean).join('\n')

    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0.8,
        messages: [
          { role: 'system', content: sysContent },
          { role: 'user', content: '请输出 json。' },
        ],
      }),
    }, 9000)
    if (!response.ok) return sendJson(res, 200, { ok: false, fallback: 'local', poem: LOCAL_CLOSING_POEMS[0] })
    const payload = await response.json()
    let parsed
    try { parsed = JSON.parse(cleanJsonString(payload?.choices?.[0]?.message?.content || '{}')) }
    catch { return sendJson(res, 200, { ok: false, fallback: 'local', poem: LOCAL_CLOSING_POEMS[0] }) }
    const poem = String(parsed.poem || '').trim()
    const lines = poem.split(/\n+/).map(s => s.trim()).filter(Boolean)
    if (lines.length !== 4 || lines.some(l => l.length < 4 || l.length > 7)) {
      return sendJson(res, 200, { ok: false, fallback: 'local', poem: LOCAL_CLOSING_POEMS[Math.floor(Math.random() * LOCAL_CLOSING_POEMS.length)] })
    }
    return sendJson(res, 200, { ok: true, source: 'deepseek', poem: lines.join('\n') })
  } catch (e) {
    console.error('[closing-poem] error:', e?.message)
    return sendJson(res, 200, { ok: false, fallback: 'local', poem: LOCAL_CLOSING_POEMS[Math.floor(Math.random() * LOCAL_CLOSING_POEMS.length)] })
  }
}

// ============================================================
// POST /api/collect-final-answer —— 曲终一问的答案，静默入库
// 只记读者答的那句话与阅读足迹，不校验身份、不返回内容、不打扰阅读。
// ============================================================
const collectedDir = join(root, '.data')
async function collectFinalAnswer(req, res) {
  try {
    const input = await readJson(req)
    const answer = String(input.answer || '').trim().slice(0, 200)
    if (!answer) return sendJson(res, 200, { ok: false, reason: 'empty' })
    await mkdir(collectedDir, { recursive: true })
    const record = {
      ts: Number(input.ts) || Date.now(),
      answer,
      carried: (input.carried && typeof input.carried === 'object') ? { char: String(input.carried.char || '').slice(0, 2), keptLabel: String(input.carried.keptLabel || '') } : null,
      dwellChars: Array.isArray(input.dwellChars) ? input.dwellChars.map(String).slice(0, 40) : [],
      dwellCount: Math.max(0, Number(input.dwellCount) || 0),
    }
    await appendFile(join(collectedDir, 'final-answers.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    return sendJson(res, 200, { ok: true })
  } catch {
    return sendJson(res, 200, { ok: false, reason: 'collect_error' })
  }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function serveFile(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(dist, safePath)
  if (!file.startsWith(dist)) return sendJson(res, 403, { ok: false })

  // 缓存策略：
  //   index.html → no-cache（每次验证，确保拿到最新 JS 文件名）
  //   带 hash 的 JS/CSS/PNG → max-age=31536000（一年，hash 变了就是新文件）
  //   其他 → no-cache
  // 这样浏览器永远不会用旧 JS 覆盖新 JS，避免"新旧音色同时在响"。
  function cacheHeadersFor(fp) {
    const base = basename(fp)
    if (base === 'index.html') return 'no-cache'
    // Vite 产物格式: index-<hash>.js / index-<hash>.css
    if (/^index-[a-zA-Z0-9_-]+\.(js|css)$/.test(base)) return 'public, max-age=31536000, immutable'
    if (/\.(png|jpg|jpeg|svg|woff2)$/.test(base)) return 'public, max-age=86400'
    return 'no-cache'
  }

  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    const data = await readFile(file)
    const ct = mime[extname(file)] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cacheHeadersFor(file) })
    res.end(data)
  } catch {
    try {
      const data = await readFile(join(dist, 'index.html'))
      res.writeHead(200, { 'Content-Type': mime['.html'], 'Cache-Control': 'no-cache' })
      res.end(data)
    } catch {
      sendJson(res, 404, { ok: false })
    }
  }
}

export async function requestHandler(req, res) {
  // 统一路径：去掉查询串，保证 /api/* 精确匹配（Vercel 上也会走到这里）
  if (req.url) req.url = req.url.split('?')[0]
  if (req.url === '/api/status') {
    return sendJson(res, 200, { ok: true, semantic: apiKey ? 'deepseek' : 'local', model: apiKey ? model : null })
  }
  if (req.url === '/api/interpret' && req.method === 'POST') return interpret(req, res)
  if (req.url === '/api/stage' && req.method === 'POST') return stage(req, res)
  if (req.url === '/api/plan' && req.method === 'POST') return plan(req, res)
  if (req.url === '/api/dream-evidence' && req.method === 'POST') return dreamEvidence(req, res)
  if (req.url === '/api/dream-assess' && req.method === 'POST') return dreamAssess(req, res)
  if (req.url === '/api/dream-whisper' && req.method === 'POST') return dreamWhisper(req, res)
  if (req.url === '/api/inner-voice' && req.method === 'POST') return innerVoice(req, res)
  if (req.url === '/api/portrait-state' && req.method === 'POST') return portraitState(req, res)
  if (req.url === '/api/awakening' && req.method === 'POST') return awakening(req, res)
  if (req.url === '/api/inscription' && req.method === 'POST') return inscription(req, res)
  if (req.url === '/api/echo' && req.method === 'POST') return echoSelect(req, res)
  if (req.url === '/api/b-plan' && req.method === 'POST') return bPlan(req, res)
  if (req.url === '/api/whisper' && req.method === 'POST') return whisper(req, res)
  if (req.url === '/api/page-note' && req.method === 'POST') return pageNote(req, res)
  if (req.url === '/api/chat' && req.method === 'POST') return chat(req, res)
  if (req.url === '/api/rollup' && req.method === 'POST') return rollup(req, res)
  if (req.url === '/api/final-question' && req.method === 'POST') return finalQuestion(req, res)
  if (req.url === '/api/closing-poem' && req.method === 'POST') return closingPoem(req, res)
  if (req.url === '/api/collect-final-answer' && req.method === 'POST') return collectFinalAnswer(req, res)
  return serveFile(req, res)
}

// 本地直跑：node server.mjs（Vercel 云端不 listen，由平台调用 requestHandler）
if (process.env.VERCEL !== '1') {
  createServer(requestHandler).listen(port, '127.0.0.1', () => {
    console.log('牡丹亭 Agent: http://127.0.0.1:' + port)
    console.log(apiKey ? '语义路径: DeepSeek (' + model + ')' : '语义路径: 本地规则兜底（未设置 DEEPSEEK_API_KEY）')
  })
}
