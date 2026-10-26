#!/bin/bash
# Builds Monty.app next to this script.
#
#   ./build.sh                                  local build, ad-hoc signed, copied to /Applications
#   SIGN_IDENTITY="Developer ID Application: …" ./build.sh
#                                               signed with the hardened runtime, which Apple's
#                                               notary requires
#   SIGN_IDENTITY=… NOTARY_PROFILE=monty-notary ./build.sh
#                                               also notarized, stapled, and zipped to Monty.zip
#                                               for a release
#
# Notary credentials: a keychain profile (xcrun notarytool store-credentials monty-notary)
# on a Mac, or APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD in CI.
# MONTY_VERSION sets the bundle version; it defaults to the extension's version, so the
# extension can tell when the installed app is older than itself.
# Ad-hoc signing still matters locally: macOS ties notification permission to a signed bundle id.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${MONTY_VERSION:-$(node -p "require('../../vscode/package.json').version" 2>/dev/null || echo 0.0.0)}"
swift build -c release
APP=Monty.app
rm -rf "$APP" Monty.zip
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
BIN="$(swift build -c release --show-bin-path)/MontyApp"
cp "$BIN" "$APP/Contents/MacOS/Monty"
# The notification ping (scripts/make-ping.py). UNNotificationSound finds it by name in Resources.
cp Resources/Ping.wav "$APP/Contents/Resources/Ping.wav"

# The app icon (AppIcon.swift). Without one, notifications show a blank white tile.
ICONSET="$(mktemp -d)/AppIcon.iconset"
"$BIN" --iconset "$ICONSET"
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$ICONSET"
rm -rf "$(dirname "$ICONSET")"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Monty</string>
  <key>CFBundleDisplayName</key><string>Monty</string>
  <key>CFBundleIdentifier</key><string>dev.adivmaimon.monty</string>
  <key>CFBundleExecutable</key><string>Monty</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License. github.com/adivmaimon/monty</string>
</dict>
</plist>
PLIST

if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  # A name matching two certificates (the same one imported twice) is ambiguous to codesign:
  # use the first match's hash instead.
  ID="$SIGN_IDENTITY"
  if [[ ! "$ID" =~ ^[0-9A-F]{40}$ ]]; then
    ID=$(security find-identity -v -p codesigning | awk -v n="\"$SIGN_IDENTITY\"" 'index($0, n) {print $2; exit}')
    [[ -n "$ID" ]] || { echo "No code-signing identity named $SIGN_IDENTITY" >&2; exit 1; }
  fi
  codesign --force --options runtime --timestamp --sign "$ID" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "Signed $(pwd)/$APP ($VERSION)"
else
  codesign --force --sign - "$APP"
  echo "Built $(pwd)/$APP ($VERSION, ad-hoc signed)"
fi

if [[ -n "${NOTARY_PROFILE:-}" || -n "${APPLE_ID:-}" ]]; then
  [[ -n "${SIGN_IDENTITY:-}" ]] || { echo "Notarizing needs SIGN_IDENTITY" >&2; exit 1; }
  if [[ -n "${NOTARY_PROFILE:-}" ]]; then auth=(--keychain-profile "$NOTARY_PROFILE")
  else auth=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"); fi
  # The notary takes a zip; the ticket is stapled to the app, then the app is zipped again
  # so the download carries the ticket and opens offline without a Gatekeeper prompt.
  ditto -c -k --keepParent "$APP" Monty-notarize.zip
  result=$(xcrun notarytool submit Monty-notarize.zip "${auth[@]}" --wait --timeout 30m --output-format json)
  rm -f Monty-notarize.zip
  echo "$result"
  status=$(echo "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
  if [[ "$status" != "Accepted" ]]; then
    xcrun notarytool log "$(echo "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')" "${auth[@]}" || true
    echo "Notarization was not accepted ($status)" >&2
    exit 1
  fi
  # Stapling fetches the ticket from Apple's CDN, which can drop the connection on CI
  # ("The network connection was lost", error 68) right after a successful notarization.
  # Five tries, 20 s apart, ride out a blip; the notarization itself is not repeated.
  for try in 1 2 3 4 5; do
    if xcrun stapler staple "$APP"; then break; fi
    if [[ $try == 5 ]]; then echo "Could not staple the notarization ticket" >&2; exit 68; fi
    echo "Staple failed (try $try of 5), retrying in 20 s" >&2
    sleep 20
  done
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
  ditto -c -k --keepParent "$APP" Monty.zip
  echo "Notarized: $(pwd)/Monty.zip"
fi

# Local builds only: a copy in /Applications, so Spotlight and Launchpad find it. CI and
# release builds leave the machine alone.
if [[ -z "${CI:-}" && -z "${NOTARY_PROFILE:-}" && -z "${APPLE_ID:-}" ]]; then
  # Quit a running copy first: replacing a running bundle's files leaves the old binary in memory.
  pkill -f '/Applications/Monty.app/Contents/MacOS/Monty' || true
  rm -rf /Applications/Monty.app
  cp -R "$APP" /Applications/Monty.app
  # Re-register so Finder and Notification Center pick up the icon instead of a cached blank one.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Monty.app || true
  echo "Copied to /Applications/Monty.app"
fi
