import { Media } from './media';

/**
 * Admin-specific media interface that extends the base Media type with
 * visibility control metadata. This interface is used in admin API responses
 * and should never be exposed to public-facing endpoints.
 *
 * @extends Media - Base media interface with all standard fields
 */
export interface AdminMedia extends Media {
    /**
     * Whether this media item is hidden from public view.
     * When true, the media is excluded from all public API responses.
     */
    is_hidden: boolean;

    /**
     * Timestamp when the media was hidden.
     * Null when the media is currently visible (is_hidden = false).
     */
    hidden_at: string | null;

    /**
     * User ID of the administrator who hid this media.
     * Null when the media is currently visible (is_hidden = false).
     */
    hidden_by: number | null;

    /**
     * Username of the administrator who hid this media.
     * Null when the media is currently visible (is_hidden = false).
     * This is a JOIN result from the users table for display purposes.
     */
    hidden_by_username: string | null;
}

/**
 * Represents a single entry in the moderation history log.
 * Used in moderation history API responses to display the audit trail
 * of visibility changes for a media item.
 */
export interface ModerationLogEntry {
    /**
     * Unique identifier for this log entry.
     */
    log_id: number;

    /**
     * ID of the media item this log entry is about.
     */
    media_id: number;

    /**
     * User ID of the administrator who performed this action.
     */
    admin_id: number;

    /**
     * Username of the administrator who performed this action.
     * This is a JOIN result from the users table for display purposes.
     */
    admin_username: string;

    /**
     * The action that was performed: either 'hide' or 'unhide'.
     */
    action: 'hide' | 'unhide';

    /**
     * Optional reason provided by the administrator for this moderation action.
     * Maximum 500 characters as enforced by the database constraint.
     */
    reason: string | null;

    /**
     * Timestamp when this moderation action was performed.
     * ISO 8601 format string.
     */
    created_at: string;
}
