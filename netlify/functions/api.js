// Netlify 云函数入口：/api/* 全部路由到这里，复用 server.mjs 的 requestHandler。
// 在 Netlify 项目设置里配置环境变量 DEEPSEEK_API_KEY（可选 DEEPSEEK_MODEL）即启用完整 AI；
// 未配置时 server.mjs 内部会走本地规则兜底，体验不崩。
import { Readable } from 'node:stream'
import { requestHandler } from '../../server.mjs'

// 从 Netlify event 还原原始 /api/* 路径
function originalApiPath(event) {
  try {
    const u = new URL(event.rawUrl || '')
    if (u.pathname) return u.pathname
  } catch { /* 忽略非法 URL */ }
  const p = event.path || ''
  return p.startsWith('/.netlify/functions/') ? '' : p
}

export async function handler(event) {
  const path = originalApiPath(event)
  if (!path.startsWith('/api/')) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false }),
    }
  }

  // 把 Netlify event 包装成 server.mjs 期望的 Node req/res
  const req = Readable.from([event.body || ''])
  req.method = event.httpMethod || 'POST'
  req.url = path
  req.headers = event.headers || {}

  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(code, headers) {
      this.statusCode = code
      if (headers) Object.assign(this.headers, headers)
    },
    setHeader(k, v) { this.headers[k] = v },
    write(c) { if (c) chunks.push(Buffer.from(c)) },
    end(c) { if (c) chunks.push(Buffer.from(c)) },
  }

  await requestHandler(req, res)

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  }
}
