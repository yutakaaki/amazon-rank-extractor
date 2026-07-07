#!/bin/bash
# ダブルクリックで実行: 毎日6:00/18:00の自動抽出をインストールする。
# 抽出 → GitHubへpush → GitHub Pagesで公開（iPadからどこでも閲覧）。
# (pmset の設定で管理者パスワードを求められます)
set -e
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
AGENTS="$HOME/Library/LaunchAgents"
WAKE_TIME="05:58:00"   # 朝の自動抽出(06:00)の少し前にMacを起こす
PAGES_URL="https://yutakaaki.github.io/amazon-rank-extractor/"

mkdir -p "$AGENTS" "$PROJECT_DIR/results" "$PROJECT_DIR/logs" "$PROJECT_DIR/snapshots" "$PROJECT_DIR/docs"

echo "▶ プロジェクト: $PROJECT_DIR"
echo "▶ node: $NODE_BIN"

# 旧構成(常駐Web)が残っていれば解除しておく
launchctl unload "$AGENTS/com.amazonrank.web.plist" 2>/dev/null || true
rm -f "$AGENTS/com.amazonrank.web.plist"

# 毎日6:00と18:00に本日発売を自動抽出する LaunchAgent
# (18:00の回で朝→夕のランク変化比較を生成し、結果とダイジェストをGitHubへpush)
DAILY_PLIST="$AGENTS/com.amazonrank.daily.plist"
cat > "$DAILY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.amazonrank.daily</string>
  <!-- 実行時刻は起床時刻(5:58/17:58)と一致させ、caffeinate -i で実行中の再スリープを防ぐ。
       (時刻をずらすと起床→再スリープの隙間でジョブが次の起床まで遅延するため) -->
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE_BIN</string><string>$PROJECT_DIR/src/daily.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>58</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>58</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/daily.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/daily.out.log</string>
</dict></plist>
EOF

launchctl unload "$DAILY_PLIST" 2>/dev/null || true
launchctl load "$DAILY_PLIST"

# スリープからの自動起床(電源接続時)。要管理者パスワード。
echo ""
echo "▶ スリープからの自動起床を設定します(管理者パスワードを入力してください)。"
sudo pmset repeat wakeorpoweron MTWRFSU "$WAKE_TIME"

# 夕方(18:00)も自動起床できるよう、pmset だけをパスワード無しで許可(限定設定)。
# これにより朝の実行後に「当日夕方の起床」を自動で予約し直せる。
PMSET_BIN="$(command -v pmset || echo /usr/bin/pmset)"
SUDOERS_FILE="/etc/sudoers.d/amazonrank-pmset"
echo "$(whoami) ALL=(root) NOPASSWD: $PMSET_BIN" | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chmod 440 "$SUDOERS_FILE"
if sudo visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
  sudo pmset schedule wake "$(date '+%m/%d/%Y') 17:58:00" 2>/dev/null || true
  echo "  ✓ 夕方の自動起床も有効化しました。"
else
  echo "  ⚠️ sudoers検証に失敗したため夕方の自動起床は無効化します(18時は起動中のみ実行)。"
  sudo rm -f "$SUDOERS_FILE"
fi

echo ""
echo "✅ インストール完了！"
echo "   ・毎日6:00と18:00に本日発売のコミックを自動抽出し、GitHubへ反映します。"
echo "     18:00の回で『朝→夕のランク変化(上昇率%)』も生成されます。"
echo "   ・iPad等からの閲覧(どこからでも): $PAGES_URL"
echo "   ・電源アダプタに接続したままにしてください(スリープ可・フタ閉じOK)。"
echo ""
echo "このウィンドウは閉じて構いません。"
