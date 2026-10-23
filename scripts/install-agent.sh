#!/bin/bash
# Runs the Monty core at login and keeps it running (launchd user agent).
# Undo: launchctl bootout gui/$(id -u)/dev.monty.core && rm ~/Library/LaunchAgents/dev.monty.core.plist
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/dev.monty.core.plist"
(cd "$DIR" && npm run build >/dev/null)
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.monty.core</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/dist/src/cli.js</string></array>
  <key>EnvironmentVariables</key><dict><key>MONTY_PROJECTS</key><string>${MONTY_PROJECTS:-}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/monty.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/monty.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/dev.monty.core" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Monty core runs at login. Panel: http://127.0.0.1:4747/  Log: ~/Library/Logs/monty.log"
