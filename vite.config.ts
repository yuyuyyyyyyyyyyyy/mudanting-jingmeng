import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4175',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    // preview 也要代理 /api，否则前端（4173）访问不到后端（4175）的 AI 接口
    proxy: {
      '/api': 'http://127.0.0.1:4175',
    },
  },
})
