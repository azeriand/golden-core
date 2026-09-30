// @vitest-environment jsdom
//
// Example tests — desktop Upload_Button in the normal navbar bar (Task 7.2).
//
// The Upload_Button is the `TbPhotoPlus` action Button in
// `app/components/navbar.tsx`, rendered inside the `{!isDemo && (...)}` block of
// the "Barra normal" branch, with `onClick={() => fileInputRef.current?.click()}`.
// Its className carries the mobile treatment (`bg-pink-500/90!`, `text-white!`)
// plus the `md:` desktop overrides fixed in task 7.1.
//
// These tests render the REAL <Navbar/> in jsdom. Navbar reads several Zustand
// singletons (global/upload/media-ui/event/auth) and `useParams` from
// next/navigation. The stores are real singletons the test drives via
// `setState`; only `next/navigation` is mocked (it has no jsdom-friendly runtime
// outside the app router). Nothing about the button's own logic is mocked.
//
//   Assertions:
//     1. Non-demo: the Upload_Button (its file-picker <input>) is present in the
//        DOM. Demo (isDemo = true): the button/input is absent. (Req 6.1)
//     2. Clicking the button invokes the file picker: spying on
//        HTMLInputElement.prototype.click shows it is called after a click on the
//        button. (Req 6.3)
//     3. Mobile classes unchanged: the button retains the `bg-pink-500/90!` and
//        `text-white!` mobile tokens. (Req 6.4)
//
//   Validates: Requirements 6.1, 6.3, 6.4

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// --- next/navigation mock -----------------------------------------------------
// Navbar calls `useParams()` to read the "event-slug". The app-router hooks have
// no standalone runtime, so provide a minimal mock returning a slug. Only the
// hooks Navbar touches are stubbed.
vi.mock("next/navigation", () => ({
  useParams: () => ({ "event-slug": "test-event" }),
}));

import Navbar from "../app/components/navbar";
import useEventStore from "../app/src/stores/event.store";
import useUploadStore from "../app/src/stores/upload.store";
import useGlobalStore from "../app/src/stores/global.store";
import useMediaUiStore from "../app/src/stores/media-ui.store";

// The hidden file <input> the Upload_Button triggers carries this accept list
// (see navbar.tsx). Use it to locate the input without depending on the library
// Button's internal markup.
const FILE_INPUT_SELECTOR =
  'input[type="file"][accept="image/*,video/*,.heic,.heif,.mov,.mp4"]';

// Find the Upload_Button by its distinctive mobile className token. The library
// <Button> forwards the passed className onto its rendered <button>.
function findUploadButton(container: HTMLElement): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll("button"));
  return (
    (buttons.find((b) =>
      b.className.includes("bg-pink-500/90!")
    ) as HTMLButtonElement) ?? null
  );
}

beforeEach(() => {
  // Default to a non-demo event in the "normal bar" (not selection mode) so the
  // Upload_Button branch renders. Reset per test to avoid cross-test leakage.
  useEventStore.setState({ isDemo: false, event: null });
  useUploadStore.setState({ items: [] });
  useGlobalStore.setState({ state: "home" });
  useMediaUiStore.setState({ isSelectionMode: false, selectedIds: new Set() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Navbar Upload_Button visibility (Req 6.1)", () => {
  it("renders the Upload_Button (file picker input) for a non-demo event", () => {
    useEventStore.setState({ isDemo: false });
    const { container } = render(<Navbar />);

    // The hidden file input only exists inside the {!isDemo && (...)} block.
    expect(container.querySelector(FILE_INPUT_SELECTOR)).not.toBeNull();
    // And its trigger button is present.
    expect(findUploadButton(container)).not.toBeNull();
  });

  it("does NOT render the Upload_Button for a demo event", () => {
    useEventStore.setState({ isDemo: true });
    const { container } = render(<Navbar />);

    // Demo events gate out the whole {!isDemo && (...)} block: no input, no button.
    expect(container.querySelector(FILE_INPUT_SELECTOR)).toBeNull();
    expect(findUploadButton(container)).toBeNull();
  });
});

describe("Navbar Upload_Button opens the file picker (Req 6.3)", () => {
  it("invokes the hidden file input's click() when the button is clicked", () => {
    useEventStore.setState({ isDemo: false });
    // Spy on the prototype so we capture the click regardless of which input the
    // ref resolves to; the handler calls fileInputRef.current?.click().
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");

    const { container } = render(<Navbar />);
    const button = findUploadButton(container);
    expect(button).not.toBeNull();

    fireEvent.click(button as HTMLButtonElement);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Navbar Upload_Button retains its mobile classes (Req 6.4)", () => {
  it("keeps the bg-pink-500/90! and text-white! mobile tokens", () => {
    useEventStore.setState({ isDemo: false });
    const { container } = render(<Navbar />);

    const button = findUploadButton(container);
    expect(button).not.toBeNull();

    const className = (button as HTMLButtonElement).className;
    // Mobile appearance tokens must be unchanged by the task 7.1 md:-only fix.
    expect(className).toContain("bg-pink-500/90!");
    expect(className).toContain("text-white!");
  });
});
