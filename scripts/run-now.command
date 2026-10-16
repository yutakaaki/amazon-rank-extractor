#!/bin/bash
# ダブルクリックで実行: 本日分の抽出を今すぐ手動で行う。
# 朝(0600)か夕(1800)かは現在時刻から自動判定する(午前=朝 / 午後=夕)。
# 自動実行を取り逃した時や、やり直したい時に使う。
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# 二重起動の防止(同じ日に2回走らせると無駄にAmazonへ連続アクセスするため)
if pgrep -f "src/daily.js" > /dev/null; then
  echo "⚠️ すでに実行中です。"
  echo "   自動実行が動いているか、先ほど起動した処理が残っています。"
  echo "   完了を待ってから、もう一度お試しください。"
  echo ""
  echo "   （進捗は logs/daily.out.log で確認できます）"
  echo "このウィンドウは閉じて構いません。"
  exit 0
fi

HOUR=$(date +%H)
if [ "$HOUR" -lt 12 ]; then TAG=0600; LABEL="朝(6:00)"; else TAG=1800; LABEL="夕(18:00)"; fi

echo "▶ 本日分の抽出を ${LABEL} として実行します。"
echo "  作品数によって10分〜2時間ほどかかります。このウィンドウは閉じないでください。"
echo ""

node src/daily.js "$TAG"

echo ""
echo "✅ 完了しました。数分後に公開ページへ反映されます。"
echo "   https://yutakaaki.github.io/amazon-rank-extractor/"
echo "このウィンドウは閉じて構いません。"
