/**
 * The head/tail cut both of Arij's write-path caps are built on.
 *
 * `agent_session_chunks.content` and `agent_sessions.prompt` are capped the
 * same way — keep the opening, keep the verdict, replace the middle with a
 * line that says how much went — and differ only in their numbers and in the
 * marker they write. Extracted here so the UTF-8 boundary walk exists once:
 * two copies of it would be two places for the same off-by-one to hide, and
 * a cut that lands inside a character decodes to U+FFFD rather than failing.
 *
 * Server-side: `Buffer` is what the cap is measured in. The two vocabularies
 * that go with it — `chunk-cap.ts` and `prompt-cap.ts` — stay free of it so
 * the markers remain readable from client components.
 */

export interface HeadTailCapOptions {
  /** Ceiling on the UTF-8 bytes kept. Text at or under it is returned as is. */
  maxBytes: number;
  /** Bytes kept from the start. */
  headBytes: number;
  /** Bytes kept from the end. */
  tailBytes: number;
  /** Builds the line written between them, given the bytes dropped. */
  marker: (elidedBytes: number) => string;
}

/**
 * Cut `text` down to `maxBytes`, keeping a head and a tail with an explicit
 * marker between them.
 *
 * The common case — text under the cap — costs one `byteLength` scan and no
 * allocation at all, which matters because this runs once per chunk emission
 * on every live session. Only text actually over the cap is buffered, and
 * then out of ONE copy: head and tail are cut from the same buffer, because
 * the values this matters for are megabytes and a `Buffer.from` per end would
 * double the peak allocation for no gain.
 *
 * `headEnd < tailStart` always holds, because callers keep head + tail under
 * the cap and the cap is under `buffer.length` on this branch.
 *
 * Newlines around the marker so it is a line of its own however the head and
 * the tail happen to end — both surfaces that render this text render it line
 * by line, and `splitCappedPrompt` undoes exactly this shape.
 */
export function capTextHeadTail(
  text: string,
  options: HeadTailCapOptions
): { text: string; capped: boolean } {
  if (Buffer.byteLength(text, "utf8") <= options.maxBytes) {
    return { text, capped: false };
  }
  const buffer = Buffer.from(text, "utf8");

  // Walk off any continuation byte (0b10xxxxxx) so neither cut lands inside a
  // character: back for the head's end, forward for the tail's start.
  let headEnd = options.headBytes;
  while (headEnd > 0 && (buffer[headEnd] & 0xc0) === 0x80) headEnd--;
  let tailStart = buffer.length - options.tailBytes;
  while (tailStart < buffer.length && (buffer[tailStart] & 0xc0) === 0x80) {
    tailStart++;
  }

  return {
    text:
      `${buffer.subarray(0, headEnd).toString("utf8")}\n` +
      `${options.marker(tailStart - headEnd)}\n` +
      `${buffer.subarray(tailStart).toString("utf8")}`,
    capped: true,
  };
}
