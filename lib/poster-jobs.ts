// Backward-compatibility shim — DO NOT add new logic here.
//
// `lib/poster-jobs.ts` is preserved so that existing callers (routes, tests,
// backfill scripts) keep working without modification. All real logic has moved
// to `lib/media-jobs.ts`, which generalises the poster queue to support
// 'poster', 'image', and 'video' job kinds.
//
// Migration path for callers:
//   - Replace `import { enqueuePosterJob, isVideoType } from '@/lib/poster-jobs'`
//     with  `import { enqueueMediaJob, isVideoType } from '@/lib/media-jobs'`
//     and call `enqueueMediaJob(db, mediaId, 'poster')`.
//
// This shim wraps `enqueueMediaJob` with a `'poster'` kind so the call-site
// signature is unchanged: enqueuePosterJob(db, mediaId) → boolean.

import type { Pool, PoolClient } from 'pg';
import { enqueueMediaJob, isVideoType as _isVideoType, isImageType as _isImageType } from './media-jobs';

type Executor = Pick<Pool | PoolClient, 'query'>;

/**
 * Idempotently enqueue a poster job for a video media row.
 *
 * @deprecated Use `enqueueMediaJob(db, mediaId, 'poster')` from
 *   `@/lib/media-jobs` instead. This wrapper exists only for backward
 *   compatibility with existing callers.
 */
export async function enqueuePosterJob(
    db: Executor,
    mediaId: number,
): Promise<boolean> {
    return enqueueMediaJob(db, mediaId, 'poster');
}

/**
 * True when a media row's stored type denotes a video.
 *
 * @deprecated Import `isVideoType` from `@/lib/media-jobs` instead.
 */
export const isVideoType = _isVideoType;

/**
 * True when a media row's stored type denotes an image.
 *
 * @deprecated Import `isImageType` from `@/lib/media-jobs` instead.
 */
export const isImageType = _isImageType;
