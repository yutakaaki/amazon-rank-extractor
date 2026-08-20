#!/bin/bash
# ダブルクリックで実行: X(Twitter)のログイン用ブラウザを開く（初回のみ／セッション切れ時）。
# ※ ログインはご自身で行ってください。このツールはパスワードを一切保存・送信しません。
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
node src/xsearch.js --login
echo ""
echo "完了しました。このウィンドウは閉じて構いません。"
