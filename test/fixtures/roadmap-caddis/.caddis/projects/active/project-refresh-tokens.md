# Refresh tokens

**Status:** In progress
**Depends on:** project-session-store.md

## Goal

A 30-day refresh token keeps people signed in.

## Phases

### Phase 1 - Issue - DONE (2026-11-01)
### Phase 2 - Rotate - DONE (2026-11-03)
### Phase 3 - Revoke on sign-out
### Phase 4 - Clean up

## Notes

The plan template reads:

```
**Depends on:** project-billing-v2.md
```

## Open Questions

- How long before an unused token expires? Recommended: 30 days.
- Store tokens hashed? Yes, SHA-256 (owner, 2026-11-02).
