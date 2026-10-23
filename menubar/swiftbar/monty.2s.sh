#!/bin/bash
# <xbar.title>Monty</xbar.title>
# <xbar.desc>Claude Code progress in the menu bar</xbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
#
# Quick-test menu bar for Monty. The core draws everything; this just fetches it.
# Install: brew install --cask swiftbar, point SwiftBar at a plugin folder, then
#   ln -s <path to monty>/menubar/swiftbar/monty.2s.sh <plugin folder>/
PORT="${MONTY_PORT:-4747}"
if ! curl -s --max-time 1 "http://127.0.0.1:${PORT}/api/swiftbar"; then
  # Monty only runs while VS Code is open.
  echo "◌ | color=gray"
  echo "---"
  echo "Monty runs while VS Code is open | color=gray"
  echo "Open VS Code | href=vscode://"
fi
