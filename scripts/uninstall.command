#!/bin/bash
# ダブルクリックで実行: 自動実行・常駐・自動起床をすべて解除する。
set +e
AGENTS="$HOME/Library/LaunchAgents"

launchctl unload "$AGENTS/com.amazonrank.web.plist" 2>/dev/null
launchctl unload "$AGENTS/com.amazonrank.daily.plist" 2>/dev/null
rm -f "$AGENTS/com.amazonrank.web.plist" "$AGENTS/com.amazonrank.daily.plist"

echo "▶ スリープ自動起床の設定を解除します(管理者パスワードを入力してください)。"
sudo pmset repeat cancel
sudo pmset schedule cancelall 2>/dev/null || true
sudo rm -f /etc/sudoers.d/amazonrank-pmset

echo "✅ 解除しました。Web画面の常駐・毎日の自動抽出・自動起床・pmset限定許可を停止しました。"
echo "このウィンドウは閉じて構いません。"
