"use client";

import { FieldKicker, Mono, PROMPT_SEGMENT } from "@/components/piscine";
import { PROMPT_ANATOMY_ORDER } from "@/lib/tokens/estimator";
import { formatTokens, type PromptAnatomyRow } from "@/components/spec/spec-format";

interface PromptBarRowProps {
  row: PromptAnatomyRow;
  /**
   * The LARGEST row total on screen. Percentages are computed against it, not
   * against each row's own total — that is what makes the bars comparable and
   * "élaguer ici paie partout" legible instead of asserted.
   */
  max: number;
}

/** A segment narrower than this cannot hold its label without clipping. */
const LABEL_MIN_PERCENT = 7.5;

export function PromptBarRow({ row, max }: PromptBarRowProps) {
  const denominator = max > 0 ? max : row.total;
  const segments = PROMPT_ANATOMY_ORDER.map((key) => ({
    key,
    tokens: row.segments[key] ?? 0,
    percent: denominator > 0 ? ((row.segments[key] ?? 0) / denominator) * 100 : 0,
  })).filter((segment) => segment.tokens > 0);

  const filled = segments.reduce((sum, segment) => sum + segment.percent, 0);

  return (
    <div
      data-testid="prompt-bar-row"
      className="flex items-center gap-[12px]"
      title={row.sampledAt ? `${row.agentName} · ${row.sampledAt}` : undefined}
    >
      <span className="flex w-[172px] shrink-0 items-baseline gap-[5px] text-[12.5px] font-semibold text-foreground max-[1199px]:w-[132px]">
        <span className="min-w-0 truncate">{row.agentName}</span>
        {/* The role is an uppercase token ("BUILD", "REVIEW", "BUG FIX"),
            which is the only kind of label allowed below 11px — and only when
            it is tracked. FieldKicker is what enforces the tracking. */}
        <FieldKicker size={9.5} stratum="land" className="shrink-0">
          {`· ${row.role}`}
        </FieldKicker>
      </span>

      <div className="flex h-[26px] flex-1 overflow-hidden rounded-[8px]">
        {segments.map((segment) => {
          const annotation =
            segment.key === "ticket" || segment.key === "system"
              ? row.annotations[segment.key]
              : undefined;
          return (
            <span
              key={segment.key}
              data-testid={`prompt-bar-segment-${segment.key}`}
              className="flex items-center justify-center"
              style={{
                width: `${segment.percent}%`,
                background: PROMPT_SEGMENT[segment.key],
              }}
            >
              {segment.percent >= LABEL_MIN_PERCENT ? (
                // Ink on EVERY segment colour, never white: the six segment
                // fills are pastels chosen to carry ink.
                // Hidden below 900px — at 26px tall a 9.5px label clips long
                // before that, and a clipped numeral is worse than none.
                <Mono size={9.5} tone="ink" className="max-[899px]:hidden">
                  {annotation
                    ? `${formatTokens(segment.tokens)} — ${annotation}`
                    : formatTokens(segment.tokens)}
                </Mono>
              ) : null}
            </span>
          );
        })}
        {filled < 99.9 ? (
          // "Le blanc en fin de barre" — what this agent did NOT receive.
          <span
            data-testid="prompt-bar-tail"
            className="flex-1 bg-card-translucent"
          />
        ) : null}
      </div>

      <Mono
        size={11}
        weight={700}
        tone="ink"
        className="w-[52px] shrink-0 text-right"
      >
        {formatTokens(row.total)}
      </Mono>
    </div>
  );
}
