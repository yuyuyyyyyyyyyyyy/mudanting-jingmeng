// Vercel 云函数入口：/api/* 全部路由到这个函数，
// 复用 server.mjs 里同一套 requestHandler（DeepSeek 密钥走 Vercel 环境变量）。
import { requestHandler } from '../server.mjs'

export default async function vercelApi(req, res) {
  await requestHandler(req, res)
}
