import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compareVersions, judge, signingInfo, TEAM_ID, BUNDLE_ID } from './appcheck';

// The shape `codesign -dv --verbose=2` prints for a release build.
const signed = `Executable=/tmp/x/Monty.app/Contents/MacOS/Monty
Identifier=${BUNDLE_ID}
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1984 flags=0x10000(runtime) hashes=55+3 location=embedded
Authority=Developer ID Application: Example (${TEAM_ID})
TeamIdentifier=${TEAM_ID}
Runtime Version=14.0.0`;

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
});

test('signingInfo reads the team, bundle id and hardened runtime', () => {
  assert.deepEqual(signingInfo(signed), { teamId: TEAM_ID, identifier: BUNDLE_ID, runtime: true });
  assert.deepEqual(signingInfo('Identifier=x\nTeamIdentifier=not set'), { teamId: undefined, identifier: 'x', runtime: false });
});

test('judge: a notarized release from the right team installs; anything else is refused with a reason', () => {
  assert.deepEqual(judge({ verify: 0, gatekeeper: 0, details: signed }), { ok: true });
  const no = (r: ReturnType<typeof judge>) => (r.ok ? '' : r.reason);
  assert.match(no(judge({ verify: 1, gatekeeper: 0, details: signed })), /signature/);
  assert.match(no(judge({ verify: 0, gatekeeper: 0, details: signed.replaceAll(TEAM_ID, 'ABCDE12345') })), /team ABCDE12345/);
  assert.match(no(judge({ verify: 0, gatekeeper: 0, details: 'Identifier=Monty\nTeamIdentifier=not set' })), /no one/);
  assert.match(no(judge({ verify: 0, gatekeeper: 0, details: signed.replace(BUNDLE_ID, 'com.other.app') })), /not Monty/);
  assert.match(no(judge({ verify: 0, gatekeeper: 3, details: signed })), /Gatekeeper/);
});
