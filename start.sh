#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖..."
  npm install
fi
if [ ! -d dist ]; then
  npm run build
fi
echo "牡丹亭 · 惊梦 —— http://127.0.0.1:4173"
npm run preview
