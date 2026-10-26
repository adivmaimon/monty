---

description: "Task list for Photo Tags"
---

# Tasks: Photo Tags

**Input**: Design documents from `/specs/001-photo-tags/`

**Prerequisites**: plan.md (required), spec.md (required for user stories)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Create the tags migration in db/migrations/0042_tags.sql
- [x] T002 [P] Add the Tag type in src/models/tag.ts

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T003 Implement TagRepository in src/repos/tags.ts

## Phase 3: User Story 1 - Tag a photo (Priority: P1) 🎯 MVP

### Implementation for User Story 1

- [x] T004 [US1] Add POST /photos/:id/tags in src/api/tags.ts
- [ ] T005 [US1] Add the tag input to src/ui/PhotoView.tsx

## Phase 4: User Story 2 - Filter by tag (Priority: P2)

- [ ] T006 [P] [US2] Add ?tag= to GET /albums/:id in src/api/albums.ts
- [ ] T007 [US2] Add the tag filter chip to src/ui/AlbumView.tsx

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T008 [P] Document tags in docs/tags.md

## Dependencies & Execution Order

- Setup (Phase 1) before Foundational (Phase 2)
