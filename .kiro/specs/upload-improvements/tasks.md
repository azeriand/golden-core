# Implementation Plan: Upload Improvements

## Overview

This plan implements the upload improvements feature for Golden Core: multi-file selection, video support, per-item progress tracking with blur overlay, retry logic, and concurrent upload processing. The implementation uses TypeScript throughout, leveraging Zustand for state management and XHR for progress-aware uploads.

## Tasks

- [ ] 1. Database migration and shared types
  - [x] 1.1 Create database migration to add `media_type` column
    - Create a SQL migration file that adds `media_type VARCHAR(10) NOT NULL DEFAULT 'image'` to the `public.media` table
    - Add CHECK constraint: `media_type IN ('image', 'video')`
    - _Requirements: 2.2_

  - [x] 1.2 Update the Media TypeScript interface
    - Add `media_type: 'image' | 'video'` field to the existing `Media` interface/type
    - Ensure all existing references to Media accommodate the new field
    - _Requirements: 2.2, 2.3_

- [x] 2. Upload XHR utility
  - [x] 2.1 Create `upload-xhr.ts` utility module
    - Implement `uploadFile(options: UploadOptions): Promise<Media>` that wraps XMLHttpRequest in a Promise
    - Include `upload.onprogress` callback that computes `Math.floor((loaded / total) * 100)` and calls `onProgress`
    - Set XHR `timeout` to 30000ms; reject on timeout, network error, or non-2xx status
    - Send file as FormData with a `date` field
    - _Requirements: 5.1, 5.2, 6.1, 6.2_

  - [ ]* 2.2 Write property test for progress computation (Property 9)
    - **Property 9: Progress computation correctness**
    - Generate random (bytesSent, totalBytes) pairs where 0 ≤ bytesSent ≤ totalBytes and totalBytes > 0
    - Verify computed progress equals `Math.floor((bytesSent / totalBytes) * 100)` and result is in [0, 100]
    - **Validates: Requirements 5.1**

- [x] 3. Upload Zustand store
  - [x] 3.1 Create `upload.store.ts` with UploadItem interface and UploadStore
    - Define `UploadItem` interface with fields: id, file, previewUrl, status, progress, retryCount, error, mediaResult
    - Define `UploadStore` interface with items array, activeCount, and actions: enqueueFiles, retryItem, dismissItem, processQueue
    - Implement `enqueueFiles`: generate UUID for each file, create object URL preview, set status to 'queued', append to items array
    - Implement `processQueue`: pick items with status 'queued' while activeCount < 3, set status to 'uploading', call uploadFile, update progress, handle success/failure
    - Implement `retryItem`: if retryCount < 3, increment retryCount, reset progress to 0, set status to 'uploading'; if retryCount >= 3, set status to 'exhausted'
    - Implement `dismissItem`: remove item from items array, revoke object URL
    - On enqueue, switch global state to 'myPhotos' via globalStore
    - _Requirements: 1.2, 1.3, 3.1, 3.2, 3.4, 3.5, 6.1, 6.4, 6.6, 6.7_

  - [ ]* 3.2 Write property test for file count validation (Property 1)
    - **Property 1: File count validation**
    - Generate random arrays of mock files with lengths 0–30
    - Verify acceptance for length 1–20, rejection for length > 20, no-op for length 0
    - **Validates: Requirements 1.1, 1.4, 1.5**

  - [ ]* 3.3 Write property test for enqueue append semantics (Property 2)
    - **Property 2: Enqueue append semantics**
    - Generate random existing queue states (length M) and new batches (length N, 1 ≤ N ≤ 20)
    - Verify resulting queue has length M + N, first M items unchanged, new items in selection order
    - **Validates: Requirements 1.2, 3.4, 3.5**

  - [ ]* 3.4 Write property test for concurrency invariant (Property 3)
    - **Property 3: Concurrency invariant**
    - Generate random event sequences (enqueue, complete, fail) and simulate store processing
    - Verify that at no point does the count of items with status 'uploading' exceed 3
    - **Validates: Requirements 1.3**

  - [ ]* 3.5 Write property test for state machine transitions (Property 10)
    - **Property 10: Upload state machine transitions**
    - Generate random sequences of success/failure events with varying retry counts
    - Verify: failure → status 'failed'; retry with retryCount < 3 → status 'uploading', progress 0; retry with retryCount >= 3 → status 'exhausted', no upload initiated
    - **Validates: Requirements 6.1, 6.4, 6.6**

- [x] 4. Checkpoint - Core upload logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Navbar multi-file picker modifications
  - [x] 5.1 Modify `navbar.tsx` to support multi-file selection with video
    - Change the hidden `<input type="file">` to accept `image/*,video/mp4,video/quicktime,video/webm`
    - Add `multiple` attribute to the input element
    - In the `onChange` handler, validate file count ≤ 20; if exceeded, display error message and prevent enqueue
    - On valid selection, call `uploadStore.enqueueFiles(files, eventSlug)`
    - _Requirements: 1.1, 1.4, 1.5, 2.1, 3.1_

  - [ ]* 5.2 Write property test for MIME type validation (Property 4)
    - **Property 4: MIME type validation**
    - Generate random strings as MIME types plus known valid MIME types
    - Verify acceptance for `{image/jpeg, image/png, image/webp, image/heic, video/mp4, video/quicktime, video/webm}`, rejection for all others
    - **Validates: Requirements 2.1, 2.4**

  - [ ]* 5.3 Write property test for media type classification (Property 5)
    - **Property 5: Media type classification**
    - Generate files with random accepted MIME types
    - Verify MIME starting with `video/` → media_type 'video', starting with `image/` → media_type 'image'
    - **Validates: Requirements 2.2**

  - [ ]* 5.4 Write property test for file size validation (Property 6)
    - **Property 6: File size validation**
    - Generate random file sizes from 0 to 200 MB
    - Verify acceptance for size ≤ 104,857,600 bytes, rejection for size > 104,857,600 bytes
    - **Validates: Requirements 2.5**

- [x] 6. Media API route updates
  - [x] 6.1 Update Media API route for video support and validation
    - Add MIME type validation: accept `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `video/mp4`, `video/quicktime`, `video/webm`; return 400 for unsupported types
    - Add file size validation: reject files > 100 MB with 400 status
    - Determine `media_type` from MIME prefix (`video/` → 'video', `image/` → 'image')
    - Add `media_type` to the database INSERT query
    - Return `media_type` in the JSON response
    - _Requirements: 2.2, 2.4, 2.5_

- [x] 7. Checkpoint - API and upload pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Media item placeholder component
  - [x] 8.1 Create `media-item-placeholder.tsx` component
    - Accept `MediaItemPlaceholderProps` with `item: UploadItem`, `onRetry`, `onDismiss`
    - Display `previewUrl` as `<img>` for images or `<video poster>` for video files
    - Apply `filter: blur(10px)` CSS when `item.status === 'uploading'`
    - Overlay a circular SVG progress ring showing `item.progress` percentage
    - Show error icon when `status === 'failed'`
    - Tap handler: call `onRetry(id)` if `retryCount < 3`, call `onDismiss(id)` if `retryCount >= 3` (exhausted)
    - On success: remove blur with 300ms CSS transition, display final content
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.3, 5.4, 5.5, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [ ]* 8.2 Write property test for blur state (Property 8)
    - **Property 8: Blur state driven by upload status**
    - Generate UploadItems with random statuses from the set {'queued', 'uploading', 'success', 'failed', 'exhausted'}
    - Verify blur is applied if and only if status === 'uploading'
    - **Validates: Requirements 4.1, 4.3**

- [x] 9. Masonry grid integration and media item updates
  - [x] 9.1 Modify `masonry.tsx` to render upload placeholders
    - Accept `uploadingItems: UploadItem[]` prop from the upload store
    - Render `<MediaItemPlaceholder>` components at the top of the grid, before server-loaded media
    - Wire `onRetry` and `onDismiss` callbacks to the upload store actions
    - _Requirements: 3.4, 3.5, 4.1, 4.4_

  - [x] 9.2 Rename `image.tsx` to `media-item.tsx` and add video support
    - Rename the component file from `image.tsx` to `media-item.tsx`
    - Conditionally render `<img>` when `media_type === 'image'` or `<video>` when `media_type === 'video'`
    - Video elements include `controls`, `playsInline`, and `preload="metadata"` attributes
    - Update all imports of the old component name across the codebase
    - _Requirements: 2.3_

  - [ ]* 9.3 Write property test for MyPhotos filter correctness (Property 7)
    - **Property 7: MyPhotos filter correctness**
    - Generate random arrays of media items with varying `user_id` values and a random authenticated user ID
    - Verify filtering returns exactly those items where `item.user_id === authenticatedUserId`
    - **Validates: Requirements 3.3**

- [ ] 10. Integration tests
  - [ ]* 10.1 Write integration tests for upload flows
    - Test full upload flow: select file → enqueue → XHR mock → success → placeholder replaced with final media
    - Test multi-file concurrent upload with mock API delays verifying max 3 concurrent
    - Test retry flow: upload fails → tap → retry succeeds → blur removed
    - Test server validation: reject oversized file (400), reject invalid MIME type (400)
    - _Requirements: 1.2, 1.3, 2.4, 2.5, 4.2, 6.1, 6.4, 6.5_

- [x] 11. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design document using `fast-check`
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout; all implementations use TypeScript
- XHR is used instead of fetch for upload progress tracking capability

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "6.1"] },
    { "id": 2, "tasks": ["2.2", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "3.5", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.4", "8.1"] },
    { "id": 5, "tasks": ["8.2", "9.1", "9.2"] },
    { "id": 6, "tasks": ["9.3", "10.1"] }
  ]
}
```
