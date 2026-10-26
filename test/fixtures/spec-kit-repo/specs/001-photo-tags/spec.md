# Feature Specification: Photo Tags

**Feature Branch**: `001-photo-tags`

**Created**: 2026-10-20

**Status**: In Progress

**Input**: User description: "Let people tag photos and filter an album by tag"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tag a photo (Priority: P1)

A user opens a photo and adds one or more tags to it.

**Acceptance Scenarios**:

1. **Given** a photo with no tags, **When** the user adds "beach", **Then** the photo shows the tag "beach"

### User Story 2 - Filter by tag (Priority: P2)

A user filters an album to the photos with a tag.

### Edge Cases

- What happens when a tag has 200 characters?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let users add tags to a photo
- **FR-002**: System MUST filter an album by one tag

## Success Criteria *(mandatory)*

- **SC-001**: Users tag a photo in under 5 seconds
