// Installs the Mac menu bar app on request. It downloads the notarized Monty.zip from
// this repo's latest GitHub release, checks it was signed by Monty's developer and that
// Gatekeeper accepts it (appcheck.ts), then puts it in ~/Applications and starts it.
//
// This is Monty's one network request and its one write outside VS Code, so both happen
// only when the person clicks Install. Nothing is installed on its own.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { compareVersions, judge, RELEASE_ZIP } from './appcheck';

const OFFER_KEY = 'monty.menubarOffer'; // 'never' or the time of the last "Not now"
// Not now means not this fortnight: often enough to be findable, rarely enough not to nag.
const ASK_AGAIN_MS = 14 * 24 * 3600 * 1000;
// The app is about 1 MB zipped; anything far bigger is not it.
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

export const userAppPath = () => path.join(os.homedir(), 'Applications', 'Monty.app');

/** The installed app, if any: the setting when it points somewhere, else the usual places. */
export function findApp(setting: string): string | undefined {
  const candidates = setting ? [setting] : ['/Applications/Monty.app', userAppPath()];
  return candidates.find((p) => fs.existsSync(path.join(p, 'Contents', 'Info.plist')));
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

async function appVersion(app: string): Promise<string | undefined> {
  const r = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  return r.code === 0 ? r.out.trim() : undefined;
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`the download failed (${res.status})`);
  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > MAX_ZIP_BYTES) throw new Error('the download is far bigger than the app');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error('the download is far bigger than the app');
  fs.writeFileSync(to, buf);
}

/** Download, check, install, start. Throws with a reason a person can act on. */
async function installFromRelease(progress: vscode.Progress<{ message?: string }>): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-app-'));
  try {
    progress.report({ message: 'Downloading…' });
    const zip = path.join(tmp, 'Monty.zip');
    await download(RELEASE_ZIP, zip);
    progress.report({ message: 'Checking the signature…' });
    const unpacked = path.join(tmp, 'x');
    if ((await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked])).code !== 0) throw new Error('the download is not a valid zip');
    const app = path.join(unpacked, 'Monty.app');
    if (!fs.existsSync(app)) throw new Error('the download does not contain Monty.app');
    const verdict = judge({
      verify: (await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])).code,
      gatekeeper: (await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])).code,
      details: (await run('/usr/bin/codesign', ['-dv', '--verbose=2', app])).out,
    });
    if (!verdict.ok) throw new Error(`the download was refused: ${verdict.reason}`);
    progress.report({ message: 'Installing…' });
    const dest = userAppPath();
    // A running copy keeps its old binary in memory; quit it first.
    await run('/usr/bin/pkill', ['-f', `${dest}/Contents/MacOS/Monty`]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    // ditto keeps the signature, permissions and stapled ticket intact.
    if ((await run('/usr/bin/ditto', [app, dest])).code !== 0) throw new Error(`could not write ${dest}`);
    spawn('open', ['-g', '-a', dest], { detached: true, stdio: 'ignore' }).unref();
    return dest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function installMenuBarApp(): Promise<void> {
  if (process.platform !== 'darwin') {
    void vscode.window.showInformationMessage('The Monty menu bar app is for macOS.');
    return;
  }
  try {
    const dest = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Monty menu bar app' }, installFromRelease);
    void vscode.window.showInformationMessage(`Monty is now stationed in your menu bar, arriving and leaving with VS Code. (Installed to ${dest.replace(os.homedir(), '~')})`);
  } catch (e) {
    void vscode.window.showErrorMessage(`The menu bar app wouldn't install: ${(e as Error).message}. Nothing was changed.`);
  }
}

/**
 * On activation: offer the app once if it is missing, or an update if the installed one
 * (in ~/Applications, where Monty put it) is older than this extension.
 */
export async function offerMenuBarApp(context: vscode.ExtensionContext, appSetting: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const installed = findApp(appSetting);
  const mine = context.extension.packageJSON.version as string;
  if (installed) {
    if (installed !== userAppPath()) return; // someone else's build (e.g. a local one): leave it
    const theirs = await appVersion(installed);
    if (!theirs || compareVersions(theirs, mine) >= 0) return;
    const pick = await vscode.window.showInformationMessage(`A newer menu bar app is ready (${theirs} → ${mine}).`, 'Update', 'Not now');
    if (pick === 'Update') await installMenuBarApp();
    return;
  }
  const last = context.globalState.get<string | number>(OFFER_KEY);
  if (last === 'never' || (typeof last === 'number' && Date.now() - last < ASK_AGAIN_MS)) return;
  const pick = await vscode.window.showInformationMessage(
    'May Monty take up a post in your menu bar? A monocle there shows progress and taps the glass when a session needs you, even with VS Code in the background.',
    'Install',
    'Not now',
    "Don't ask again",
  );
  if (pick === 'Install') await installMenuBarApp();
  else if (pick === "Don't ask again") void context.globalState.update(OFFER_KEY, 'never');
  else void context.globalState.update(OFFER_KEY, Date.now());
}
