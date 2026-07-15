/**
 * Minimal Server-Sent-Events frame parser + stream pump for POST-based streaming. The rest of this
 * codebase has never needed `EventSource` (browser-native SSE is GET-only); `/api/chat` streams
 * over a POST response body instead (`hono/streaming`'s `streamSSE` on the server — see
 * `src/api/chat.ts`'s `sendEvent`), so the client side needs its own tiny reader rather than the
 * usual `new EventSource(url)`.
 *
 * Frames are `data: <json>\n\n` per the wire format `writeSSE` emits; this parser only implements
 * the `data:` line, since the server never sends `event:`/`id:`/retry lines or comments.
 */

/** Splits an accumulated buffer into complete `\n\n`-terminated frames plus whatever incomplete
 * tail remains. A chunk boundary can land anywhere — mid-frame, mid-line, or mid-multi-byte-char —
 * so the caller re-feeds `rest` back in as the start of the next chunk. Each complete frame's
 * `data:` line(s) are newline-joined into one string (multi-line `data:` payloads are part of the
 * SSE spec, though this server never emits them — `JSON.stringify` output is always single-line).
 * Frames with no `data:` line (e.g. a bare comment) are silently dropped — nothing to deliver. */
export function splitSSEFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: string[] = [];
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length > 0) frames.push(dataLines.join("\n"));
  }
  return { frames, rest };
}

/** Pumps a fetch `Response`'s body through `splitSSEFrames`, calling `onFrame` with each frame's
 * raw `data:` payload (JSON text, still unparsed — the caller decides how to handle a malformed
 * one) in arrival order. Handles both a single chunk containing several complete frames and a
 * frame whose bytes are split across multiple chunks. Resolves once the stream ends; releases the
 * reader lock in a `finally` so an aborted or failed read never leaks it. Throws only if the
 * response has no readable body, or if the underlying read itself rejects (e.g. the caller's
 * `AbortSignal` fires mid-read — the fetch that produced `response` should be given the same
 * signal so this happens automatically). */
export async function readSSEStream(response: Response, onFrame: (data: string) => void): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new Error("response has no readable body to stream");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitSSEFrames(buffer);
      buffer = rest;
      for (const frame of frames) onFrame(frame);
    }
    // Flush any multi-byte tail the decoder was holding onto, then force a final frame boundary in
    // case the stream ended without a trailing blank line (defensive only — `writeSSE` always
    // terminates every frame with `\n\n`).
    buffer += decoder.decode();
    const { frames } = splitSSEFrames(`${buffer}\n\n`);
    for (const frame of frames) onFrame(frame);
  } finally {
    reader.releaseLock();
  }
}
