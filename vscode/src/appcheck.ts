// Pure parts of installing the menu bar app: no vscode import, so plain node tests them
// (`npm test` in vscode/). install.ts runs the commands and feeds their output in here.

/** Who signs release builds. A download signed by anyone else is refused. */
export const TEAM_ID = '37RUL3H793';
export const BUNDLE_ID = 'dev.adivmaimon.monty';
export const RELEASE_ZIP = 'https://github.com/adivmaimon/monty/releases/latest/download/Monty.zip';

/** -1, 0 or 1 for dotted versions ("0.2.0" < "0.10.1"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `codesign -dv --verbose=2` prints its details on stderr as Key=Value lines. */
export function signingInfo(output: string): { teamId?: string; identifier?: string; runtime: boolean } {
  const get = (k: string) => new RegExp(`^${k}=(.+)$`, 'm').exec(output)?.[1]?.trim();
  const team = get('TeamIdentifier');
  return {
    // Ad-hoc and unsigned builds say "not set".
    teamId: team === 'not set' ? undefined : team,
    identifier: get('Identifier'),
    runtime: /flags=0x[0-9a-f]*\(.*runtime.*\)/.test(output),
  };
}

export interface CheckResults {
  /** `codesign --verify --deep --strict` exit code */
  verify: number;
  /** `spctl --assess --type execute` exit code */
  gatekeeper: number;
  /** `codesign -dv --verbose=2` output */
  details: string;
}

/** Whether a downloaded app may be installed, and if not, a reason a person can act on. */
export function judge(r: CheckResults): { ok: true } | { ok: false; reason: string } {
  if (r.verify !== 0) return { ok: false, reason: 'its signature is broken or missing' };
  const info = signingInfo(r.details);
  if (info.teamId !== TEAM_ID) return { ok: false, reason: `it was signed by ${info.teamId ? `team ${info.teamId}` : 'no one'}, not Monty's developer` };
  if (info.identifier !== BUNDLE_ID) return { ok: false, reason: `it is not Monty (bundle id ${info.identifier ?? 'missing'})` };
  if (r.gatekeeper !== 0) return { ok: false, reason: 'macOS Gatekeeper rejected it (not notarized)' };
  return { ok: true };
}
