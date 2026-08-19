# Requirements Document

## Introduction

This feature improves the upload experience in Golden Core by enabling multi-file selection, supporting video uploads alongside images, providing per-item upload progress via a circular indicator, and automatically navigating the user to the "myPhotos" section where newly uploaded items appear blurred until fully processed.

## Glossary

- **Upload_Manager**: The client-side module responsible for orchestrating file selection, upload requests, and tracking progress for each item.
- **Media_API**: The server-side API endpoint (`/api/event/[event-slug]/media`) that receives and processes uploaded files.
- **File_Picker**: The native file selection dialog triggered by the upload button in the Navbar component.
- **Progress_Indicator**: A circular UI element overlaid on each uploading media item that displays the upload completion percentage (0–100%).
- **Media_Item**: A single image or video file being uploaded or already stored in the system.
- **MyPhotos_View**: The filtered view of the event page that shows only media belonging to the current authenticated user (global state "myPhotos").
- **Blur_Overlay**: A visual effect applied to media thumbnails that are currently uploading, rendering them blurry until the upload completes.
- **Vercel_Blob**: The external storage service (`@vercel/blob`) used to persist uploaded files.

## Requirements

### Requirement 1: Multi-File Selection

**User Story:** As an event attendee, I want to select multiple files at once from the file picker, so that I can upload a batch of photos and videos without repeating the selection process for each file.

#### Acceptance Criteria

1. WHEN the user taps the upload button, THE File_Picker SHALL allow selection of up to 20 files simultaneously.
2. WHEN the user confirms the file selection, THE Upload_Manager SHALL enqueue all selected files for upload and append them to any already-enqueued items without replacing the existing queue.
3. THE Upload_Manager SHALL upload each enqueued file as an independent request to the Media_API, processing at most 3 uploads concurrently and queuing remaining files until a slot becomes available.
4. IF the user selects zero files and dismisses the File_Picker, THEN THE Upload_Manager SHALL take no action.
5. IF the user selects more than 20 files, THEN THE File_Picker SHALL prevent confirmation and display an error message indicating the maximum selection limit has been exceeded.

### Requirement 2: Video Upload Support

**User Story:** As an event attendee, I want to upload video files in addition to images, so that I can share video memories from the event.

#### Acceptance Criteria

1. THE File_Picker SHALL accept image files (JPEG, PNG, WEBP, HEIC) and video files (MP4, MOV, WEBM).
2. WHEN a video file is received, THE Media_API SHALL store the video in Vercel_Blob, persist a media record in the database, and record the media type as "video" to distinguish it from image records.
3. WHEN a video Media_Item is displayed, THE Masonry grid SHALL render an inline video player element with playback controls instead of an image tag.
4. IF an uploaded file type is not in the accepted list, THEN THE Media_API SHALL reject the file with a 400 status code and an error message indicating the unsupported file type.
5. IF an uploaded file exceeds 100 MB, THEN THE Media_API SHALL reject the file with a 400 status code and an error message indicating the file size limit.

### Requirement 3: Post-Selection Navigation to MyPhotos

**User Story:** As an event attendee, I want to be redirected to the "My Photos" section immediately after selecting files, so that I can see my uploads appearing in real time.

#### Acceptance Criteria

1. WHEN the user confirms the file selection in the File_Picker, THE Upload_Manager SHALL change the global view state to "myPhotos".
2. IF the global view state is already "myPhotos" when the user confirms the file selection, THEN THE Upload_Manager SHALL remain on "myPhotos" without resetting the view.
3. WHEN the global view state changes to "myPhotos", THE event page SHALL display only media where the media item's user_id matches the authenticated user's id.
4. WHEN the user confirms the file selection in the File_Picker, THE Upload_Manager SHALL insert one placeholder Media_Item into the MyPhotos_View for each selected file before the upload request is sent.
5. THE Upload_Manager SHALL display placeholder Media_Items at the top of the MyPhotos_View, ordered by selection sequence (first selected file appears first).

### Requirement 4: Blur Effect on Uploading Items

**User Story:** As an event attendee, I want newly uploading items to appear blurred until the upload finishes, so that I have visual feedback that the upload is in progress.

#### Acceptance Criteria

1. WHILE a Media_Item is uploading, THE Masonry grid SHALL apply a Blur_Overlay with a blur radius of 10px to that item's thumbnail, where the thumbnail is a locally-generated preview of the selected file.
2. WHEN the upload of a Media_Item completes successfully, THE Masonry grid SHALL remove the Blur_Overlay within 300ms and display the final media content returned by the Media_API.
3. IF the upload of a Media_Item fails, THEN THE Masonry grid SHALL remove the Blur_Overlay and display an error icon on that item indicating the upload was unsuccessful.
4. WHILE a Media_Item is uploading, THE Masonry grid SHALL display the Blur_Overlay regardless of whether the user scrolls the item out of and back into the viewport.

### Requirement 5: Per-Item Upload Progress from Backend

**User Story:** As an event attendee, I want to see how far along each file's upload is, so that I know which items are almost done and which are still transferring.

#### Acceptance Criteria

1. WHILE a Media_Item is uploading, THE Upload_Manager SHALL compute upload progress as the integer percentage of bytes sent divided by total file size, yielding a value between 0 and 100.
2. WHILE a Media_Item is uploading, THE Upload_Manager SHALL update the computed progress value at least every 500 milliseconds or upon each network progress event, whichever is more frequent.
3. WHILE a Media_Item is uploading, THE Progress_Indicator SHALL display the current upload percentage as a whole number (0–100) inside a circular progress ring overlaid on the Blur_Overlay.
4. WHEN the upload percentage reaches 100, THE Progress_Indicator SHALL be removed from the Media_Item.
5. WHEN a Media_Item upload begins, THE Progress_Indicator SHALL appear on the Media_Item displaying 0%.

### Requirement 6: Upload Error Handling

**User Story:** As an event attendee, I want to know if an upload fails and have the option to retry, so that I do not lose my media.

#### Acceptance Criteria

1. IF the Media_API returns a non-success status code for a Media_Item upload, THEN THE Upload_Manager SHALL mark that item as failed.
2. IF a Media_Item upload request does not receive a response within 30 seconds, THEN THE Upload_Manager SHALL mark that item as failed.
3. WHEN a Media_Item is marked as failed, THE Masonry grid SHALL display an error icon on that item's placeholder.
4. WHEN the user taps a failed Media_Item that has not exhausted its retry attempts, THE Upload_Manager SHALL retry the upload for that item and restore the uploading state (Blur_Overlay and Progress_Indicator) on that item.
5. WHEN a retried Media_Item upload completes successfully, THE Masonry grid SHALL remove the error icon and Blur_Overlay and display the final media content.
6. IF a Media_Item upload fails after 3 retry attempts (4 total attempts including the original), THEN THE Upload_Manager SHALL display an error message on that item that remains visible until the user dismisses the item, and SHALL disable further tap-to-retry for that item.
7. WHEN the user taps a Media_Item that has exhausted its retry attempts, THE Upload_Manager SHALL remove that item's placeholder from the MyPhotos_View.
