/**
 * Area 4 (spec §11): a placeholder only — Task 6.x builds the real streaming chat surface. Rendered
 * as a disabled nav tab so the layout reserves the space cleanly rather than omitting it.
 */

export function ChatTab() {
  return (
    <button
      type="button"
      disabled
      title="Chat — coming online in the next deploy"
      aria-disabled="true"
      aria-label="Chat — coming online in the next deploy"
      className="cursor-not-allowed whitespace-nowrap rounded-lg px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-ink-faint"
    >
      Chat<span className="hidden sm:inline"> — coming online in the next deploy</span>
    </button>
  );
}
