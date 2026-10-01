# Design Document: Admin Hide Images

## Overview

The admin-hide-images feature provides administrators with the ability to moderate media content by controlling its visibility. This design extends the existing media management system with a visibility toggle mechanism, audit trail, and filtering capabilities while maintaining backward compatibility with public-facing endpoints.

## Architecture

### System Components

The feature integrates into the existing Next.js application architecture with the following components:

1. **Database Layer**: Extension of the `media` table with visibility state and new `media_moderation_log` table for audit trail
2. **API Layer**: New admin-specific endpoints under `/app/api/admin/media/` and modifications to existing public media endpoints
3. **Admin UI**: React components for visibility toggles, filtering, and moderation history display
4. **Authentication Middleware**: Leverages existing JWT-based authentication with `isAdmin` claim validation

### Data Model

#### Media Table Extension

```typescript
// Extended media table columns
interface MediaRow {
    media_id: number;
    user_id: number;
    content: string;
    media_type: 'image' | 'video';
    date: Date;
    section_id: number | null;
    event_id: number;
    blurhash: string | null;
    is_hidden: boolean;              // NEW: visibility state (default: false)
    hidden_at: Date | null;          // NEW: when it was hidden
    hidden_by: number | null;        // NEW: admin user_id who hid it
}
```

#### Media Moderation Log Table

```typescript
interface ModerationLogRow {
    log_id: number;                  // PRIMARY KEY
    media_id: number;                // FOREIGN KEY -> media.media_id
    admin_id: number;                // FOREIGN KEY -> users.user_id
    action: 'hide' | 'unhide';       // what action was taken
    reason: string | null;           // optional moderation reason (max 500 chars)
    created_at: Date;                // when the action occurred
}
```

### Database Schema

```sql
-- Migration: Add visibility control to media table
ALTER TABLE media
    ADD COLUMN is_hidden boolean NOT NULL DEFAULT false,
    ADD COLUMN hidden_at timestamptz,
    ADD COLUMN hidden_by integer REFERENCES users(user_id);

CREATE INDEX idx_media_is_hidden ON media(is_hidden);
CREATE INDEX idx_media_hidden_at ON media(hidden_at) WHERE is_hidden = true;

-- Moderation log table for audit trail
CREATE TABLE media_moderation_log (
    log_id serial PRIMARY KEY,
    media_id integer NOT NULL REFERENCES media(media_id) ON DELETE CASCADE,
    admin_id integer NOT NULL REFERENCES users(user_id),
    action varchar(10) NOT NULL CHECK (action IN ('hide', 'unhide')),
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reason_length CHECK (length(reason) <= 500)
);

CREATE INDEX idx_moderation_log_media_id ON media_moderation_log(media_id);
CREATE INDEX idx_moderation_log_created_at ON media_moderation_log(created_at DESC);
```

## API Design

### Admin Endpoints

#### Toggle Media Visibility

**Endpoint**: `PATCH /api/admin/media/[media_id]/visibility`

**Authentication**: Requires valid JWT with `isAdmin: true`

**Request Body**:
```typescript
interface ToggleVisibilityRequest {
    hidden: boolean;
    reason?: string;  // optional, max 500 chars
}
```

**Response** (200 OK):
```typescript
interface ToggleVisibilityResponse {
    success: true;
    media_id: number;
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
}
```

**Error Responses**:
- 401: Unauthorized (missing or invalid JWT)
- 403: Forbidden (user is not an admin)
- 404: Media item not found
- 400: Invalid request body or reason exceeds 500 characters

**Implementation**:
```typescript
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ media_id: string }> }
): Promise<Response> {
    // 1. Verify admin authentication
    const auth = verifyRequest(request);
    if (!auth.valid || !auth.isAdmin) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: auth.valid ? 403 : 401 }
        );
    }

    const { media_id } = await params;
    const body = await request.json();

    // 2. Validate request
    if (typeof body.hidden !== 'boolean') {
        return new Response(
            JSON.stringify({ error: 'Invalid request: hidden must be boolean' }),
            { status: 400 }
        );
    }

    if (body.reason && body.reason.length > 500) {
        return new Response(
            JSON.stringify({ error: 'Reason exceeds 500 character limit' }),
            { status: 400 }
        );
    }

    // 3. Update media visibility (with row-level lock for consistency)
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const updateResult = await client.query(
            `UPDATE media
             SET is_hidden = $1,
                 hidden_at = CASE WHEN $1 = true THEN now() ELSE NULL END,
                 hidden_by = CASE WHEN $1 = true THEN $2 ELSE NULL END
             WHERE media_id = $3
             RETURNING media_id, is_hidden, hidden_at, hidden_by`,
            [body.hidden, auth.userId, parseInt(media_id)]
        );

        if (updateResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return new Response(
                JSON.stringify({ error: 'Media not found' }),
                { status: 404 }
            );
        }

        // 4. Log the moderation action
        await client.query(
            `INSERT INTO media_moderation_log (media_id, admin_id, action, reason)
             VALUES ($1, $2, $3, $4)`,
            [
                parseInt(media_id),
                auth.userId,
                body.hidden ? 'hide' : 'unhide',
                body.reason || null
            ]
        );

        await client.query('COMMIT');

        return new Response(
            JSON.stringify({
                success: true,
                ...updateResult.rows[0]
            }),
            { status: 200 }
        );
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
```

#### Get Media with Admin Metadata

**Endpoint**: `GET /api/admin/media?event_id={id}&hidden={true|false|all}`

**Authentication**: Requires valid JWT with `isAdmin: true`

**Query Parameters**:
- `event_id` (required): Filter by event
- `hidden` (optional): Filter by visibility state (`true`, `false`, or `all`, default: `all`)
- `section_id` (optional): Filter by section
- `limit` (optional): Page size (default: 50, max: 200)
- `offset` (optional): Pagination offset (default: 0)

**Response** (200 OK):
```typescript
interface AdminMediaResponse {
    media: Array<{
        media_id: number;
        user_id: number;
        username: string;
        content: string;
        media_type: 'image' | 'video';
        date: string;
        section_id: number | null;
        likes: number;
        is_hidden: boolean;
        hidden_at: string | null;
        hidden_by: number | null;
        hidden_by_username: string | null;
    }>;
    total: number;
    has_more: boolean;
}
```

#### Get Moderation History

**Endpoint**: `GET /api/admin/media/[media_id]/history`

**Authentication**: Requires valid JWT with `isAdmin: true`

**Response** (200 OK):
```typescript
interface ModerationHistoryResponse {
    media_id: number;
    history: Array<{
        log_id: number;
        admin_id: number;
        admin_username: string;
        action: 'hide' | 'unhide';
        reason: string | null;
        created_at: string;
    }>;
}
```

### Public Endpoint Modifications

All existing public media endpoints must be updated to filter out hidden media:

#### Modified Query Pattern

```typescript
// Before: SELECT * FROM media WHERE event_id = $1
// After:  SELECT * FROM media WHERE event_id = $1 AND is_hidden = false

// Example in media feed endpoint
const result = await pool.query(
    `SELECT m.*, u.username, COALESCE(l.likes, 0) AS likes
     FROM media m
     JOIN users u ON m.user_id = u.user_id
     LEFT JOIN (
         SELECT media_id, COUNT(*) AS likes
         FROM likes
         GROUP BY media_id
     ) l ON m.media_id = l.media_id
     WHERE m.event_id = $1
       AND m.is_hidden = false  -- NEW: exclude hidden media
     ORDER BY m.date DESC
     LIMIT $2 OFFSET $3`,
    [eventId, limit, offset]
);
```

#### Direct Media Access

When non-admin users request a specific media item by ID:

```typescript
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ media_id: string }> }
): Promise<Response> {
    const auth = verifyRequest(request);
    const { media_id } = await params;

    const result = await pool.query(
        `SELECT * FROM media
         WHERE media_id = $1
           AND (is_hidden = false OR $2 = true)`,  -- allow admins to see hidden media
        [parseInt(media_id), auth.valid && auth.isAdmin]
    );

    if (result.rows.length === 0) {
        return new Response(
            JSON.stringify({ error: 'Media not found' }),
            { status: 404 }
        );
    }

    // ... rest of response shaping
}
```

### Response DTOs

#### Public Media DTO

```typescript
// app/dto/media.ts (existing, no changes to structure)
export interface Media {
    media_id: number;
    user_id: number;
    content: string;
    type: string | null;
    likes: number;
    liked: boolean;
    date: string;
    section_id: number | null;
    // NOTE: is_hidden is NOT included in public responses
}
```

#### Admin Media DTO

```typescript
// app/dto/admin-media.ts (new)
export interface AdminMedia extends Media {
    is_hidden: boolean;
    hidden_at: string | null;
    hidden_by: number | null;
    hidden_by_username: string | null;
}
```

## UI Components

### Admin Media Item Component

```typescript
// app/components/admin/MediaItemCard.tsx
import { useState } from 'react';

interface MediaItemCardProps {
    media: AdminMedia;
    onVisibilityToggle: (mediaId: number, hidden: boolean, reason?: string) => Promise<void>;
}

export function MediaItemCard({ media, onVisibilityToggle }: MediaItemCardProps) {
    const [isToggling, setIsToggling] = useState(false);
    const [showReasonDialog, setShowReasonDialog] = useState(false);

    const handleToggle = async (reason?: string) => {
        setIsToggling(true);
        try {
            await onVisibilityToggle(media.media_id, !media.is_hidden, reason);
        } finally {
            setIsToggling(false);
            setShowReasonDialog(false);
        }
    };

    return (
        <div className={`media-card ${media.is_hidden ? 'hidden-media' : ''}`}>
            <img src={media.content} alt="" />
            
            <div className="media-controls">
                <button
                    onClick={() => {
                        if (!media.is_hidden) {
                            setShowReasonDialog(true);
                        } else {
                            handleToggle();
                        }
                    }}
                    disabled={isToggling}
                    className={media.is_hidden ? 'btn-unhide' : 'btn-hide'}
                >
                    {media.is_hidden ? 'Unhide' : 'Hide'}
                </button>
                
                {media.is_hidden && (
                    <span className="hidden-badge">Hidden</span>
                )}
            </div>

            {showReasonDialog && (
                <ReasonDialog
                    onSubmit={handleToggle}
                    onCancel={() => setShowReasonDialog(false)}
                />
            )}
        </div>
    );
}
```

### Visibility Filter Component

```typescript
// app/components/admin/VisibilityFilter.tsx
interface VisibilityFilterProps {
    value: 'all' | 'visible' | 'hidden';
    onChange: (value: 'all' | 'visible' | 'hidden') => void;
}

export function VisibilityFilter({ value, onChange }: VisibilityFilterProps) {
    return (
        <div className="filter-group">
            <label>Visibility:</label>
            <select value={value} onChange={(e) => onChange(e.target.value as any)}>
                <option value="all">All Media</option>
                <option value="visible">Visible Only</option>
                <option value="hidden">Hidden Only</option>
            </select>
        </div>
    );
}
```

### Moderation History Modal

```typescript
// app/components/admin/ModerationHistory.tsx
interface ModerationHistoryProps {
    mediaId: number;
    onClose: () => void;
}

export function ModerationHistory({ mediaId, onClose }: ModerationHistoryProps) {
    const [history, setHistory] = useState<ModerationLogEntry[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch(`/api/admin/media/${mediaId}/history`)
            .then(res => res.json())
            .then(data => {
                setHistory(data.history);
                setLoading(false);
            });
    }, [mediaId]);

    return (
        <dialog open className="moderation-history-modal">
            <h2>Moderation History</h2>
            {loading ? (
                <p>Loading...</p>
            ) : (
                <ul>
                    {history.map(entry => (
                        <li key={entry.log_id}>
                            <strong>{entry.action}</strong> by {entry.admin_username}
                            <br />
                            <time>{new Date(entry.created_at).toLocaleString()}</time>
                            {entry.reason && <p className="reason">{entry.reason}</p>}
                        </li>
                    ))}
                </ul>
            )}
            <button onClick={onClose}>Close</button>
        </dialog>
    );
}
```

## Authentication & Authorization

### Admin Verification Middleware

```typescript
// app/utils/auth.ts
export interface AuthResult {
    valid: boolean;
    userId?: number;
    email?: string;
    isAdmin?: boolean;
}

export function verifyRequest(request: NextRequest): AuthResult {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return { valid: false };
    }

    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
        throw new Error('JWT_SECRET not configured');
    }

    try {
        const decoded = jwt.verify(token, jwtSecret) as {
            userId: number;
            email: string;
            isAdmin: boolean;
        };

        return {
            valid: true,
            userId: decoded.userId,
            email: decoded.email,
            isAdmin: decoded.isAdmin
        };
    } catch {
        return { valid: false };
    }
}

export function requireAdmin(auth: AuthResult): Response | null {
    if (!auth.valid) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
    }

    if (!auth.isAdmin) {
        return new Response(
            JSON.stringify({ error: 'Forbidden: Admin access required' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
    }

    return null;
}
```

## Error Handling

### Database Constraints

```sql
-- Ensure hidden_by is only set when is_hidden is true
ALTER TABLE media ADD CONSTRAINT check_hidden_by_consistency
    CHECK ((is_hidden = false AND hidden_by IS NULL AND hidden_at IS NULL)
        OR (is_hidden = true AND hidden_by IS NOT NULL AND hidden_at IS NOT NULL));
```

### Race Condition Handling

Database row-level locking prevents concurrent modifications:

```typescript
// In toggle visibility endpoint
await client.query('BEGIN');

// SELECT FOR UPDATE locks the row until transaction completes
const lockResult = await client.query(
    'SELECT media_id FROM media WHERE media_id = $1 FOR UPDATE',
    [mediaId]
);

if (lockResult.rows.length === 0) {
    await client.query('ROLLBACK');
    return notFoundResponse();
}

// Proceed with update...
await client.query('UPDATE media SET is_hidden = $1 ...', [...]);
await client.query('INSERT INTO media_moderation_log ...', [...]);

await client.query('COMMIT');
```

## Performance Considerations

### Indexing Strategy

1. **`idx_media_is_hidden`**: B-tree index on `is_hidden` for fast filtering in public queries
2. **`idx_media_hidden_at`**: Partial index on `hidden_at WHERE is_hidden = true` for admin queries sorting by when items were hidden
3. **`idx_moderation_log_media_id`**: For quick lookup of moderation history per media item
4. **`idx_moderation_log_created_at`**: For chronological queries of moderation actions

### Query Optimization

Public media queries add `AND is_hidden = false` predicate, which uses the `idx_media_is_hidden` index. Since most media is expected to be visible (is_hidden = false), this filter is highly selective and efficient.

```sql
EXPLAIN ANALYZE
SELECT * FROM media
WHERE event_id = 1 AND is_hidden = false
LIMIT 50;

-- Expected: Index Scan using idx_media_is_hidden
-- Filtered by event_id
```

## Testing Strategy

### Unit Tests

Example-based unit tests for:
- UI components render correctly with hidden/visible states
- API endpoints return correct status codes for various inputs
- Authentication middleware correctly validates admin tokens
- Specific edge cases like 500-character reason boundary

### Property-Based Tests

Property-based tests using fast-check library (minimum 100 iterations per property):

See Correctness Properties section below for detailed property specifications.

### Integration Tests

Integration tests for:
- Concurrent visibility toggles on the same media item
- Database transaction rollback on errors
- End-to-end admin workflow: hide → verify exclusion → unhide → verify restoration

## Migration Strategy

### Phase 1: Database Migration

1. Add new columns to `media` table with defaults that preserve existing behavior
2. Create `media_moderation_log` table
3. Create indexes

### Phase 2: API Updates

1. Deploy new admin endpoints
2. Update all public endpoints to filter `is_hidden = false`
3. Verify no hidden media leaks to public views

### Phase 3: UI Deployment

1. Deploy admin UI components
2. Train administrators on new moderation workflow

### Rollback Plan

```sql
-- To rollback the feature:
DROP TABLE IF EXISTS media_moderation_log;
DROP INDEX IF EXISTS idx_media_hidden_at;
DROP INDEX IF EXISTS idx_media_is_hidden;
ALTER TABLE media
    DROP COLUMN IF EXISTS is_hidden,
    DROP COLUMN IF EXISTS hidden_at,
    DROP COLUMN IF EXISTS hidden_by;
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Visibility Toggle Inverts State

*For any* media item with a current visibility state, when an administrator toggles the visibility, the resulting state SHALL be the inverse of the original state (visible → hidden, or hidden → visible).

**Validates: Requirements 1.2, 1.3**

### Property 2: State Change Returns Success

*For any* media item visibility toggle operation that completes without error, the API response SHALL contain `success: true` and SHALL include the final `is_hidden` state.

**Validates: Requirements 1.5, 6.2**

### Property 3: Admin API Includes Visibility State

*For any* admin API response containing media items, each media item SHALL include the `is_hidden` attribute.

**Validates: Requirements 2.4**

### Property 4: Visibility Filter Correctness

*For any* collection of media items with mixed visibility states, when filtered by a specific visibility state (hidden or visible), the result SHALL contain only items matching that state.

**Validates: Requirements 2.3**

### Property 5: Hidden Media Excluded from Public Views

*For any* media item with `is_hidden = true`, that item SHALL NOT appear in any public API response including feeds, galleries, search results, and profile displays.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 6: Direct Hidden Media Returns Not Found

*For any* hidden media item, when a non-administrator user requests that item directly by ID, the system SHALL return a 404 Not Found response.

**Validates: Requirements 3.4**

### Property 7: Public APIs Exclude Hidden State Field

*For any* public API response containing media items, the response SHALL NOT include the `is_hidden`, `hidden_at`, or `hidden_by` fields.

**Validates: Requirements 3.5**

### Property 8: Audit Trail Creation

*For any* media visibility state change, the system SHALL create a moderation log entry containing the admin's user ID, the current timestamp (within 1 second of the request), and the action type (hide or unhide).

**Validates: Requirements 4.1, 4.2**

### Property 9: Reason Persistence

*For any* hide action where a moderation reason is provided, the system SHALL store that reason in the moderation log entry and SHALL retrieve it when querying the moderation history.

**Validates: Requirements 5.2**

### Property 10: Reason Length Validation

*For any* moderation reason string with length ≤ 500 characters, the system SHALL accept it. *For any* reason string with length > 500 characters, the system SHALL reject the request with a 400 Bad Request response.

**Validates: Requirements 5.4**

## Dependencies

- **PostgreSQL**: Database with support for transactions, row-level locking, and CHECK constraints
- **Next.js 16**: App router with server components and API routes
- **jsonwebtoken**: JWT verification for admin authentication
- **fast-check**: Property-based testing library for test implementation
- **vitest**: Test runner for unit and property-based tests

## Security Considerations

1. **Authentication**: All admin endpoints require valid JWT with `isAdmin: true` claim
2. **Authorization**: Admin-only operations verify the `isAdmin` flag on every request
3. **SQL Injection**: All database queries use parameterized statements
4. **Information Disclosure**: Hidden state metadata is never exposed to public APIs
5. **Audit Trail**: All moderation actions are logged with admin identity for accountability
6. **Race Conditions**: Row-level locking prevents inconsistent concurrent updates

## Future Enhancements

1. **Batch Operations**: Hide/unhide multiple media items in a single request
2. **Scheduled Visibility**: Set future dates for automatic hide/unhide
3. **Moderation Categories**: Classify hidden content by violation type (inappropriate, spam, etc.)
4. **Notification System**: Alert content owners when their media is hidden
5. **Appeal System**: Allow users to contest moderation decisions
