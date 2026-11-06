# Refresh tokens for login

**Status**: In progress
**Type**: Project
**Phases**: 4

## Goal

Sessions expire after 15 minutes and log people out mid-task. A 30-day refresh token lets the client renew silently.

## Context

Access tokens live 15 minutes (`src/auth/session.ts:41`). There is no refresh path, so `web/src/api/client.ts` sends people to login on every 401.

## Risk

**Medium.** The auth middleware runs on every request. The refresh path sits behind `AUTH_REFRESH` and each phase ships on its own.

> [!WARNING]
> Reverse the migration before rolling back Phase 2.

## Experiment

Skipped: no benchmark covers auth.

## Changes

| File | Change |
| --- | --- |
| `src/auth/session.ts` | add refresh family, rotate() |
| `src/auth/tokens.ts` | New. sign, hash, compare |
| `src/auth/revoke.ts` | New. revoke one family, or all |
| `src/routes/refresh.ts` | New. POST /refresh |
| `src/routes/logout.ts` | ?all=1 |
| `src/db/migrations/0042_refresh.sql` | New. refresh_tokens table |
| `web/src/api/client.ts` | retry once on 401 |

## Invariants

None touched.

## Storage & State

N/A

## Phases

### Phase 1 - Session fields - DONE (2026-11-03)

Add the family id to the session row.

**Gate:** `npm test` passes.

### Phase 2 - Refresh endpoint - DONE (2026-11-05)

**Gate:** POST /refresh returns a new pair.

### Phase 3 - Rotation and revocation

Each refresh issues a new token in the same family. A retired token used again revokes the whole family.

**Gate:**
- [x] new token on rotate
- [x] reuse revokes family
- [ ] revoke-all returns 204

### Phase 4 - Client renewal

**Gate:** the client retries once on 401.

## Tests

- `test/refresh.test.ts`: rotation and reuse
- `test/logout.test.ts`: revoke-all
- `web/src/api/client.test.ts`: retry once

## Verification

1. Log in, wait 16 minutes, make a request: no redirect.
2. Replay an old refresh token: 401, and the live session ends too.

## Open Questions

- Should revoke-all also end the current session? Default: Yes
- Refresh lifetime when "remember me" is off? The plan uses 30 days everywhere. **Recommended:** 24 hours.
- Which store holds the families?
  - Decided: Postgres, beside sessions (owner, 2026-11-02)

## Summary

- People stay logged in.
