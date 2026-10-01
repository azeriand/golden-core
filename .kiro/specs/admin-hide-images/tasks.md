# Implementation Plan: Admin Hide Images

## Overview

This plan implements the admin-hide-images feature, which allows administrators to moderate media content by controlling visibility. The implementation includes database migrations, API endpoints for admin operations, modifications to public endpoints to filter hidden media, authentication middleware, UI components for visibility toggles, and property-based tests for correctness guarantees.

## Tasks

- [ ] 1. Create database schema and migration
  - Create migration file with media table extensions (is_hidden, hidden_at, hidden_by columns)
  - Create media_moderation_log table with audit trail structure
  - Add database indexes for performance (idx_media_is_hidden, idx_media_hidden_at, idx_moderation_log_media_id, idx_moderation_log_created_at)
  - Add CHECK constraint for hidden_by consistency
  - _Requirements: 1.2, 1.3, 1.4, 4.1, 4.2_

- [ ] 2. Implement admin authentication utilities
  - [ ] 2.1 Create or extend auth utilities with admin verification
    - Implement verifyRequest function that validates JWT and extracts isAdmin claim
    - Implement requireAdmin helper that returns appropriate error responses
    - _Requirements: All admin-facing requirements (1.x, 2.x, 4.x, 5.x)_

- [ ] 3. Implement admin API endpoints
  - [ ] 3.1 Create PATCH /api/admin/media/[media_id]/visibility endpoint
    - Verify admin authentication
    - Validate request body (hidden boolean, optional reason with 500 char limit)
    - Update media visibility with transaction and row-level locking
    - Insert moderation log entry
    - Return success response with updated visibility state
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 4.1, 4.2, 5.1, 5.2, 5.4, 6.1, 6.2, 6.3_

  - [ ]* 3.2 Write property test for visibility toggle endpoint
    - **Property 1: Visibility Toggle Inverts State**
    - **Property 2: State Change Returns Success**
    - **Validates: Requirements 1.2, 1.3, 1.5, 6.2**

  - [ ] 3.3 Create GET /api/admin/media endpoint with filtering
    - Verify admin authentication
    - Parse query parameters (event_id, hidden filter, section_id, limit, offset)
    - Query media with admin metadata (is_hidden, hidden_at, hidden_by, hidden_by_username)
    - Return paginated results with total count
    - _Requirements: 2.1, 2.3, 2.4_

  - [ ]* 3.4 Write property test for admin API visibility state inclusion
    - **Property 3: Admin API Includes Visibility State**
    - **Property 4: Visibility Filter Correctness**
    - **Validates: Requirements 2.3, 2.4**

  - [ ] 3.5 Create GET /api/admin/media/[media_id]/history endpoint
    - Verify admin authentication
    - Query moderation_log with admin usernames
    - Return chronological history with action details
    - _Requirements: 4.3, 4.4, 5.3_

  - [ ]* 3.6 Write property test for audit trail
    - **Property 8: Audit Trail Creation**
    - **Property 9: Reason Persistence**
    - **Property 10: Reason Length Validation**
    - **Validates: Requirements 4.1, 4.2, 5.2, 5.4**

- [ ] 4. Checkpoint - Ensure all admin API tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Update public API endpoints to filter hidden media
  - [ ] 5.1 Identify and update all public media query endpoints
    - Add `AND is_hidden = false` filter to media feed queries
    - Update gallery endpoints to exclude hidden media
    - Update search endpoints to exclude hidden media
    - Update profile display endpoints to exclude hidden media
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 5.2 Update direct media access endpoint
    - Add logic to return 404 for hidden media when accessed by non-admins
    - Allow admins to view hidden media directly
    - _Requirements: 3.4_

  - [ ] 5.3 Ensure public DTOs exclude visibility metadata
    - Verify that is_hidden, hidden_at, hidden_by fields are not included in public responses
    - _Requirements: 3.5_

  - [ ]* 5.4 Write property tests for public API filtering
    - **Property 5: Hidden Media Excluded from Public Views**
    - **Property 6: Direct Hidden Media Returns Not Found**
    - **Property 7: Public APIs Exclude Hidden State Field**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

- [ ] 6. Create admin DTO types
  - [ ] 6.1 Create app/dto/admin-media.ts with AdminMedia interface
    - Extend existing Media type with is_hidden, hidden_at, hidden_by, hidden_by_username fields
    - Create ModerationLogEntry interface for history responses
    - _Requirements: 2.4, 4.3, 4.4_

- [ ] 7. Implement admin UI components
  - [ ] 7.1 Create MediaItemCard component with visibility toggle
    - Display media with visibility state indicator
    - Implement toggle button with loading state
    - Show reason dialog when hiding media
    - Apply visual styling for hidden state
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 5.1_

  - [ ] 7.2 Create VisibilityFilter component
    - Implement dropdown filter (all, visible, hidden)
    - Emit filter change events
    - _Requirements: 2.3_

  - [ ] 7.3 Create ReasonDialog component
    - Implement modal dialog for entering moderation reason
    - Add character counter (max 500 characters)
    - Provide submit and cancel actions
    - _Requirements: 5.1, 5.4_

  - [ ] 7.4 Create ModerationHistory modal component
    - Fetch and display moderation history for a media item
    - Show admin username, action, timestamp, and reason for each entry
    - Implement loading state
    - _Requirements: 4.3, 4.4, 5.3_

  - [ ]* 7.5 Write unit tests for UI components
    - Test MediaItemCard renders correctly with hidden/visible states
    - Test VisibilityFilter emits correct values
    - Test ReasonDialog validation and submission
    - Test ModerationHistory displays entries correctly

- [ ] 8. Integrate admin UI into admin panel page
  - [ ] 8.1 Create or update admin media management page
    - Implement media grid with MediaItemCard components
    - Add VisibilityFilter to page controls
    - Implement visibility toggle handler that calls API
    - Handle error states and display feedback
    - Add "View History" action that opens ModerationHistory modal
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 4.3_

- [ ] 9. Final checkpoint - End-to-end validation
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property-based tests use the fast-check library with minimum 100 iterations
- All database queries use parameterized statements to prevent SQL injection
- Row-level locking with `SELECT FOR UPDATE` prevents race conditions in concurrent updates
- The migration is reversible - rollback SQL is documented in the design
- Admin authentication requires JWT with `isAdmin: true` claim
- Public APIs never expose visibility metadata fields to maintain information security
- Each task references specific requirements for traceability

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2.1"] },
    { "id": 1, "tasks": ["3.1", "6.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.5"] },
    { "id": 3, "tasks": ["3.4", "3.6", "5.1", "5.2", "5.3"] },
    { "id": 4, "tasks": ["5.4", "7.1", "7.2", "7.3", "7.4"] },
    { "id": 5, "tasks": ["7.5", "8.1"] }
  ]
}
```
