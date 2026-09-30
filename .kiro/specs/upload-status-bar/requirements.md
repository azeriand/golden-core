# Requirements Document

## Introduction

This feature adds a pill-shaped upload status bar to the bottom of the event page, rendered over the existing "Todas"/"Mis fotos" filter pill. The status bar is visible only while uploads are in progress. It shows overall upload progress as a circular progress ring with a percentage inside it, alongside two rows of Spanish text: one reporting how many items have been uploaded out of the total, and one warning the viewer not to close or reload the page. When no uploads remain active (regardless of whether some failed), the bar shows a completion state (checkmark plus a done message) and then auto-hides after a fixed delay.

This feature also fixes a defect in which the upload button (the `TbPhotoPlus` action in the normal navbar bar) does not render correctly on desktop.

The status bar reads from the existing Upload_Store (Zustand) as its single source of truth and does not change upload orchestration behavior.

## Glossary

- **Upload_Status_Bar**: The new pill-shaped UI element rendered over the filter pill at the bottom of the event page that displays aggregate upload progress and status text.
- **Upload_Store**: The existing client Zustand store (`app/src/stores/upload.store.ts`) that orchestrates uploads and exposes `items` (each an `UploadItem`) and `activeCount`.
- **Upload_Item**: A single entry in the Upload_Store `items` array, with a `status` (one of `queued`, `processing`, `uploading`, `success`, `failed`, `exhausted`, `canceled`), a `progress` value (0-100), and other fields.
- **Active_Upload**: An Upload_Item whose `status` is one of `queued`, `processing`, or `uploading` (work is pending or in flight).
- **Progress_Ring**: The circular ring inside the Upload_Status_Bar whose fill represents the aggregate byte progress of the current upload batch.
- **Aggregate_Progress**: The arithmetic mean of the `progress` values (0-100) of the Upload_Items in the current batch, expressed as a whole-number percentage.
- **Completion_State**: The Upload_Status_Bar display shown when no Active_Upload remains, replacing the percentage with a checkmark and the progress text with a done message.
- **Filter_Pill**: The existing "Barra normal" element in `app/components/navbar.tsx` containing the "Todas" and "Mis fotos" buttons, positioned fixed at the bottom of the event page.
- **Upload_Button**: The existing `TbPhotoPlus` action button in the normal navbar bar (rendered inside the `{!isDemo && (...)}` block) that opens the file picker.
- **Desktop_Breakpoint**: The Tailwind `md:` breakpoint and wider viewports.
- **Auto_Hide_Delay**: The fixed 5-second delay after which the Upload_Status_Bar hides once it enters the Completion_State.

## Requirements

### Requirement 1

**User Story:** As a guest uploading photos, I want a status bar to appear at the bottom of the event page only while my uploads are in progress, so that I can see progress without permanent screen clutter.

#### Acceptance Criteria

1. WHILE at least one Active_Upload exists in the Upload_Store, THE Upload_Status_Bar SHALL be visible.
2. WHILE no Active_Upload exists and the Completion_State is not being displayed, THE Upload_Status_Bar SHALL be hidden.
3. WHEN the first Active_Upload appears in the Upload_Store, THE Upload_Status_Bar SHALL be displayed.
4. THE Upload_Status_Bar SHALL be positioned over the Filter_Pill at the bottom of the event page.
5. WHERE the viewport is narrower than the Desktop_Breakpoint, THE Upload_Status_Bar SHALL span the full width of the viewport.
6. WHERE the viewport is at or wider than the Desktop_Breakpoint, THE Upload_Status_Bar SHALL size its width to its content.

### Requirement 2

**User Story:** As a guest uploading photos, I want to see the overall transfer progress as a ring with a percentage, so that I know how far along my upload is.

#### Acceptance Criteria

1. THE Upload_Status_Bar SHALL render a full circular Progress_Ring on its left side.
2. THE Upload_Status_Bar SHALL compute Aggregate_Progress as the arithmetic mean of the `progress` values of the Upload_Items in the current batch.
3. THE Progress_Ring SHALL fill in proportion to the Aggregate_Progress value.
4. WHILE the Completion_State is not being displayed, THE Upload_Status_Bar SHALL display the Aggregate_Progress as a whole-number percentage inside the Progress_Ring.
5. WHEN the Aggregate_Progress value changes, THE Progress_Ring fill and the displayed percentage SHALL update to the new value.

### Requirement 3

**User Story:** As a guest uploading photos, I want to see how many items have finished out of the total and a warning to keep the page open, so that I understand my progress and avoid interrupting the upload.

#### Acceptance Criteria

1. THE Upload_Status_Bar SHALL render two rows of text to the right of the Progress_Ring.
2. WHILE the Completion_State is not being displayed, THE Upload_Status_Bar SHALL display in the first text row the count of Upload_Items whose `status` is `success` and the total count of Upload_Items in the current batch, formatted in plain Spanish as "X de Y".
3. WHILE the Completion_State is not being displayed, THE Upload_Status_Bar SHALL display in the second text row a Spanish warning advising the viewer not to close or reload the page.
4. THE Upload_Status_Bar SHALL present all displayed text in Spanish.

### Requirement 4

**User Story:** As a guest uploading photos, I want the status bar to confirm when the upload run is done and then disappear on its own, so that I get clear closure without dismissing it manually.

#### Acceptance Criteria

1. WHEN no Active_Upload remains in the Upload_Store after at least one upload was in progress, THE Upload_Status_Bar SHALL enter the Completion_State.
2. WHILE in the Completion_State, THE Upload_Status_Bar SHALL replace the Progress_Ring percentage with a checkmark.
3. WHILE in the Completion_State, THE Upload_Status_Bar SHALL replace the progress text with a Spanish done message.
4. THE Upload_Status_Bar SHALL enter the Completion_State even when one or more Upload_Items ended in a `failed` or `exhausted` status.
5. WHEN the Upload_Status_Bar has been in the Completion_State for the Auto_Hide_Delay of 5 seconds, THE Upload_Status_Bar SHALL hide.
6. IF a new Active_Upload appears while the Upload_Status_Bar is in the Completion_State, THEN THE Upload_Status_Bar SHALL return to displaying progress for the new batch.

### Requirement 5

**User Story:** As a guest uploading many photos, I want the interface to stay responsive during uploads, so that scrolling and interaction do not stutter while progress updates stream in.

#### Acceptance Criteria

1. WHEN Upload_Item `progress` values update, THE Upload_Status_Bar SHALL subscribe to the Upload_Store using selectors scoped to the fields it renders so that unrelated components do not re-render on progress ticks.
2. THE Upload_Status_Bar SHALL derive Aggregate_Progress and the displayed counts solely from the Upload_Store state without maintaining a separate duplicate copy of upload progress.

### Requirement 6

**User Story:** As a guest on a desktop browser, I want the upload button to render correctly, so that I can start an upload from a desktop device.

#### Acceptance Criteria

1. WHERE the viewport is at or wider than the Desktop_Breakpoint AND the event is not a demo event, THE Upload_Button SHALL be visible in the normal navbar bar.
2. THE Upload_Button SHALL render with sufficient contrast against its background at the Desktop_Breakpoint to be visually distinguishable.
3. WHEN a viewer activates the Upload_Button on a desktop browser, THE Upload_Button SHALL open the file picker.
4. THE Upload_Button SHALL retain its existing appearance and behavior on viewports narrower than the Desktop_Breakpoint.
