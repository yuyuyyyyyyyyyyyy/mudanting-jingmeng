import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages 项目页（https://user.github.io/仓库名/）在子路径下，
  // 相对 base 让构建产物里的 JS/CSS/字体引用全部相对化，子路径下也能加载
  base: './',
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
