"use client";

import { useCallback, useState } from "react";
import { ArrowDown, Pause } from "lucide-react";

import {
  BandHeader,
  Mono,
  ProgressTrack,
  SegmentedControl,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import { SessionOutputStream } from "@/components/sessions/SessionOutputStream";
import { cn } from "@/lib/utils";

import { SessionLogTail } from "./SessionLogTail";
import type { SessionDetail } from "./types";

/**
 * LIVE LOG — the band the whole screen is built around, and the only one that
 * grows into the column's leftover height.
 *
 * Everything the frame draws is here: the label on its turquoise underline,
 * the mono meta, the tail toggle, the white terminal card and the crawling
 * indeterminate bar under it. Two things the frame does not draw are here too,
 * both deliberate and both documented in the packet brief:
 *
 * 1. `tail off` — the frame only ever shows the on-state.
 * 2. A `Log | Réponse` segmented control, shown ONLY when the session is
 *    finished AND a response stream (or a pre-chunk-store `logs.result`)
 *    exists. Frame 8a has nowhere for the response, and silently dropping a
 *    shipped feature is worse than one extra control on a screen the frame
 *    draws for a RUNNING session — where this control does not appear at all.
 */

type LogPane = "log" | "response";

const PANE_OPTIONS = [
  { value: "log" as const, label: "Log" },
  { value: "response" as const, label: "Réponse" },
];

/** Verbatim, from the old Raw Logs tab. */
const LOGS_UNAVAILABLE_COPY =
  "This session's logs.json could not be read. The raw stream below is what the process actually wrote.";
const LOGS_TRUNCATED_COPY =
  "logs.json was too large to serve in full — the stream below is the same output, paged.";

export interface LiveLogBandProps {
  projectId: string;
  sessionId: string;
  session: SessionDetail;
  isRunning: boolean;
  /** `${providerLabel}`, as the header derives it. */
  providerLabel: string;
}

/**
 * The tail toggle. No primitive covers it — it is a bare button with an icon
 * and a word.
 *
 * Its state is the ICON plus the WORD, and nothing else. It used to swap
 * `--strata-live-deep` for `--muted-foreground` between on and off, which is
 * colour encoding state — the one rule the system never bends. The colour now
 * stays the live ground's own deep in both states (colour = stratum), and the
 * arrow becomes a pause glyph when the tail is released.
 */
function TailToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  const Icon = on ? ArrowDown : Pause;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-[6px] border-0 bg-transparent p-0",
        "font-sans text-[12px] font-semibold leading-none outline-none",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        "text-strata-live-deep",
      )}
    >
      <Icon width={12} height={12} aria-hidden="true" />
      {on ? "tail on" : "tail off"}
    </button>
  );
}

export function LiveLogBand({
  projectId,
  sessionId,
  session,
  isRunning,
  providerLabel,
}: LiveLogBandProps) {
  const [tailOn, setTailOn] = useState(true);
  const [pinKey, setPinKey] = useState(0);
  const [pane, setPane] = useState<LogPane>("log");

  const releaseTail = useCallback(() => setTailOn(false), []);

  function reTail() {
    setTailOn(true);
    // Bumped so a second click still re-pins even when the tail never broke.
    setPinKey((key) => key + 1);
  }

  const responseSeed = session.chunkStreams?.response ?? null;
  const hasResponse =
    (responseSeed?.chunks?.length ?? 0) > 0 ||
    (typeof session.logs?.result === "string" && session.logs.result.length > 0);
  // A RUNNING session shows exactly what the frame draws: label, meta, tail
  // toggle, nothing else. The response only exists once the run is over.
  const showPanes = !isRunning && hasResponse;
  const activePane: LogPane = showPanes ? pane : "log";

  const meta = `${providerLabel} · session #${session.id.slice(0, 6)}${
    tailOn && activePane === "log" ? " · suit le flux" : ""
  }`;

  return (
    <StrataBand stratum="live" density="full" gap={9} grow>
      <BandHeader
        label="Live log"
        stratum="live"
        labelSize={12}
        meta={meta}
        right={
          <div className="flex items-center gap-[12px]">
            {showPanes && (
              <SegmentedControl
                options={PANE_OPTIONS}
                value={activePane}
                onChange={setPane}
                chrome="filled"
                size="sm"
                className="[--segment-inactive:var(--strata-live-mid)]"
              />
            )}
            {activePane === "log" && (
              <TailToggle on={tailOn} onToggle={reTail} />
            )}
          </div>
        }
      />

      {/* Three distinct states, kept distinct: "no logs", "logs too large to
          serve here" and "the logs file is unreadable" used to collapse into
          one silent null. `chunkStreamsUnavailable` is the third and lives on
          the terminal card itself. */}
      {/* 11px, not 10.5: both of these are full sentences of prose. The
          sub-11px allowance is for UPPERCASE TRACKED mono labels only. */}
      {session.logsUnavailable && (
        <Mono size={11} tone="danger">
          {LOGS_UNAVAILABLE_COPY}
        </Mono>
      )}
      {session.logsTruncated && (
        <Mono size={11} tone="live-mid">
          {LOGS_TRUNCATED_COPY}
        </Mono>
      )}

      {activePane === "log" ? (
        <SessionLogTail
          projectId={projectId}
          sessionId={sessionId}
          seed={session.chunkStreams?.raw ?? null}
          unavailable={session.chunkStreamsUnavailable}
          isRunning={isRunning}
          startedAt={session.startedAt ?? null}
          // Sessions predating the chunk store wrote no chunks at all; their
          // output only exists in logs.json.
          logsFallback={
            session.logs ? (
              <Mono
                as="div"
                size={11.5}
                tone="muted"
                className="whitespace-pre-wrap break-words"
              >
                {JSON.stringify(session.logs, null, 2)}
              </Mono>
            ) : null
          }
          tailOn={tailOn}
          pinKey={pinKey}
          onTailBreak={releaseTail}
        />
      ) : (
        <SurfaceCard
          radius={10}
          className="min-h-0 flex-1 overflow-y-auto px-[16px] py-[13px]"
        >
          <SessionOutputStream
            projectId={projectId}
            sessionId={sessionId}
            streamType="response"
            seed={responseSeed}
            unavailable={session.chunkStreamsUnavailable}
            isRunning={false}
            waitingLabel="Waiting for agent to respond..."
            emptyLabel="No response available"
            // Sessions predating the chunk store have no response stream;
            // their text only exists in logs.json.
            fallback={
              session.logs?.result ? (
                <Mono
                  as="div"
                  size={11.5}
                  tone="muted"
                  className="whitespace-pre-wrap break-words"
                >
                  {session.logs.result}
                </Mono>
              ) : null
            }
          />
        </SurfaceCard>
      )}

      {/* Motion is the liveness signal; a finished session gets no crawl. */}
      {isRunning && <ProgressTrack height={4} />}
    </StrataBand>
  );
}
