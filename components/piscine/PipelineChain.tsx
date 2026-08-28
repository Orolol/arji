import { Check } from "lucide-react";
import { Fragment } from "react";

import { cn } from "@/lib/utils";

import { BreathingDot } from "./BreathingDot";
import { Mono } from "./Mono";

/**
 * 6a PIPELINE (SPEC → BUILD → REVIEW → LAND, horizontal, 20px markers) and
 * 8a ENSUITE (Build → Review → Land, vertical, 8px markers) — the same
 * vocabulary in two layouts.
 *
 * The 2px on horizontal pending rings and connectors is a DELIBERATE exception
 * to the 1.5px border rule: at a 20px marker 2px reads correctly and 1.5px
 * disappears.
 *
 * CHECK GLYPH COLOUR: `--action-foreground`, not `--card`. Same resolution, and
 * same reason, as `CheckMark` — in night `--card` is the LIGHTER dark ink and a
 * `--card` glyph on the turquoise fill would vanish. The two components that
 * draw a check on a filled disc now agree.
 */
export type PipelineStepState = "done" | "live" | "pending";

export interface PipelineStep {
  label: string;
  state: PipelineStepState;
}

export interface PipelineChainProps {
  steps: PipelineStep[];
  orientation?: "horizontal" | "vertical";
  /** px. 20 for the 6a horizontal chain, 8 for the 8a vertical one. */
  markerSize?: number;
  className?: string;
}

/** Open number → inline; every colour and shape below is a utility class. */
function markerBox(markerSize: number) {
  return { width: `${markerSize}px`, height: `${markerSize}px` };
}

function HorizontalMarker({
  state,
  markerSize,
}: {
  state: PipelineStepState;
  markerSize: number;
}) {
  if (state === "live") {
    return <BreathingDot size={markerSize} tone="live" />;
  }

  if (state === "done") {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full",
          "bg-strata-live-fill text-action-foreground",
        )}
        style={markerBox(markerSize)}
      >
        <Check width={11} height={11} strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className="shrink-0 rounded-full border-2 border-track-idle"
      style={markerBox(markerSize)}
    />
  );
}

function VerticalMarker({
  state,
  markerSize,
}: {
  state: PipelineStepState;
  markerSize: number;
}) {
  if (state === "live") {
    return <BreathingDot size={markerSize} tone="live" />;
  }

  return (
    <span
      className={cn(
        "shrink-0 rounded-full",
        state === "done"
          ? "bg-strata-live-fill"
          : "border-[1.5px] border-border-strong",
      )}
      style={markerBox(markerSize)}
    />
  );
}

export function PipelineChain({
  steps,
  orientation = "horizontal",
  markerSize = orientation === "vertical" ? 8 : 20,
  className,
}: PipelineChainProps) {
  if (orientation === "vertical") {
    return (
      <div
        data-slot="pipeline-chain"
        data-orientation="vertical"
        className={cn("flex flex-col gap-[6px]", className)}
      >
        {steps.map((step, i) => (
          <div
            key={`${step.label}-${i}`}
            className="flex items-center gap-2"
            data-state={step.state}
          >
            <VerticalMarker state={step.state} markerSize={markerSize} />
            <span
              className={cn(
                "font-sans text-[12.5px]",
                step.state === "pending"
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      data-slot="pipeline-chain"
      data-orientation="horizontal"
      className={cn("flex items-center", className)}
    >
      {steps.map((step, i) => {
        // A connector is "traversed" when the step it leads INTO has been
        // reached — i.e. that step is no longer pending.
        const next = steps[i + 1];
        const traversed = next !== undefined && next.state !== "pending";

        return (
          <Fragment key={`${step.label}-${i}`}>
            <span
              className="flex min-w-0 flex-1 flex-col items-center gap-1"
              data-state={step.state}
            >
              <HorizontalMarker state={step.state} markerSize={markerSize} />
              <Mono
                size={9.5}
                weight={step.state === "live" ? 700 : 400}
                tone={
                  step.state === "done"
                    ? "live-mid"
                    : step.state === "live"
                      ? "live-deep"
                      : "muted"
                }
              >
                {step.label}
              </Mono>
            </span>
            {next !== undefined ? (
              <span
                className={cn(
                  // mb-4 optically centres the rule against the marker, not
                  // against the marker + caption stack.
                  "mb-4 h-[2px] flex-1",
                  traversed ? "bg-strata-live-fill" : "bg-track-idle",
                )}
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
