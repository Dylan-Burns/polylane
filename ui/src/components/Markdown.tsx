/**
 * Markdown renderer for assistant chat turns (`panels/Chat.tsx`). The watchdog answers in plain
 * markdown (headings, bold, inline code, lists — see the chat system prompt), which used to render
 * literally as `## …` / `**…**` text. react-markdown parses to React elements — never an HTML
 * string — so quoted log excerpts and trace ids in LLM output can't smuggle markup in.
 *
 * Every element override below maps onto the design tokens in `index.css` rather than browser
 * defaults: headings in the display face (kept close to body size — these are chat bubbles, not a
 * document), code in Plex Mono on `panel-raised` (matching the tool-output convention elsewhere),
 * and block spacing via the wrapper's `gap` instead of per-element margins so first/last children
 * never need trimming.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Fenced code blocks reset the inline-`code` chip styling via `[&_code]:*` on the `pre` — the
 * `code` override below can't tell inline from block on its own. */
const components: Components = {
  h1: ({ children }) => <h3 className="font-display text-base font-semibold text-ink">{children}</h3>,
  h2: ({ children }) => <h3 className="font-display text-base font-semibold text-ink">{children}</h3>,
  h3: ({ children }) => <h4 className="font-display text-sm font-semibold text-ink">{children}</h4>,
  h4: ({ children }) => <h5 className="font-display text-sm font-semibold text-ink">{children}</h5>,
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children }) => <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-faint">{children}</ul>,
  ol: ({ children }) => <ol className="flex list-decimal flex-col gap-1 pl-5 marker:text-ink-faint">{children}</ol>,
  li: ({ children }) => <li className="[&>ol]:mt-1 [&>ul]:mt-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-signal-glow underline decoration-signal/40 hover:decoration-signal-glow">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded border border-hairline bg-panel-raised px-1 py-px font-mono text-[0.85em] text-ink">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-hairline bg-panel-raised px-3 py-2 font-mono text-xs leading-relaxed [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => <blockquote className="flex flex-col gap-2 border-l-2 border-hairline-bright pl-3 text-ink-dim">{children}</blockquote>,
  hr: () => <hr className="border-hairline" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline bg-panel-raised px-2 py-1 text-left font-mono text-[11px] font-medium uppercase tracking-wide text-ink-dim">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1 align-top text-ink-dim">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="flex flex-col gap-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
