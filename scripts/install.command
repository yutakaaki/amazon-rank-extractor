#!/bin/bash
# ダブルクリックで実行: Web画面の常駐 + 毎朝7:00の自動抽出 をインストールする。
# (pmset の設定で管理者パスワードを求められます)
set -e
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
AGENTS="$HOME/Library/LaunchAgents"
WAKE_TIME="05:58:00"   # 朝の自動抽出(06:00)の少し前にMacを起こす
PORT=3000

mkdir -p "$AGENTS" "$PROJECT_DIR/results" "$PROJECT_DIR/logs" "$PROJECT_DIR/snapshots"

echo "▶ プロジェクト: $PROJECT_DIR"
echo "▶ node: $NODE_BIN"

# 1) Web画面を常駐させる LaunchAgent (ログイン中ずっと起動・落ちたら再起動)
WEB_PLIST="$AGENTS/com.amazonrank.web.plist"
cat > "$WEB_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.amazonrank.web</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$PROJECT_DIR/src/server.js</string></array>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>$PORT</string></dict>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/web.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/web.log</string>
</dict></plist>
EOF

# 2) 毎日6:00と18:00に本日発売を自動抽出する LaunchAgent
#    (18:00の回で朝→夕のランク変化比較CSVも生成)
DAILY_PLIST="$AGENTS/com.amazonrank.daily.plist"
cat > "$DAILY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.amazonrank.daily</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$PROJECT_DIR/src/daily.js</string></array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/daily.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/daily.out.log</string>
</dict></plist>
EOF

# 3) 読み込み(既存があれば一旦解除)
launchctl unload "$WEB_PLIST" 2>/dev/null || true
launchctl unload "$DAILY_PLIST" 2>/dev/null || true
launchctl load "$WEB_PLIST"
launchctl load "$DAILY_PLIST"

# 4) スリープからの自動起床(電源接続時)。要管理者パスワード。
echo ""
echo "▶ スリープからの自動起床を設定します(管理者パスワードを入力してください)。"
# 朝の起床(06:00直前)を定期予約
sudo pmset repeat wakeorpoweron MTWRFSU "$WAKE_TIME"

# 夕方(18:00)も自動起床できるよう、pmset だけをパスワード無しで許可(限定設定)。
# これにより毎朝の実行後に「当日夕方の起床」を自動で予約し直せる。
PMSET_BIN="$(command -v pmset || echo /usr/bin/pmset)"
SUDOERS_FILE="/etc/sudoers.d/amazonrank-pmset"
echo "$(whoami) ALL=(root) NOPASSWD: $PMSET_BIN" | sudo tee "$SUDOERS_FILE" >/dev/null
sudo chmod 440 "$SUDOERS_FILE"
if sudo visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
  # 初回ぶんとして当日夕方(17:58)の起床も予約しておく
  sudo pmset schedule wake "$(date '+%m/%d/%Y') 17:58:00" 2>/dev/null || true
  echo "  ✓ 夕方の自動起床も有効化しました。"
else
  echo "  ⚠️ sudoers検証に失敗したため夕方の自動起床は無効化します(18時は起動中のみ実行)。"
  sudo rm -f "$SUDOERS_FILE"
fi

# 5) アクセス先URLを表示
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)
echo ""
echo "✅ インストール完了！"
echo "   ・iPad等(同じWi-Fi)から:  http://$IP:$PORT"
echo "   ・このMacから:            http://localhost:$PORT"
echo "   ・毎日6:00と18:00に本日発売のコミックを自動抽出します。"
echo "     18:00の回で『朝→夕のランク変化(上昇率%)』の比較CSVも作られます。"
echo "   ・結果は画面の「保存済みの結果」に出ます。"
echo "   ・電源アダプタに接続したままにしてください(スリープ可・フタ閉じOK)。"
echo ""
echo "このウィンドウは閉じて構いません。"
