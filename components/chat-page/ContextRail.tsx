"use client";

import * as React from "react";
import { AtSign, Check, Minus } from "lucide-react";

import { BandHeader, Mono, StrataBand } from "@/components/piscine";

import { formatTokens, type ChatContextTokens } from "./chat-context-tokens";

/**
 * CONTEXTE — what the chat will actually send, in tokens (frame 11a, right rail).
 *
 * The figures come from the same chars/4 estimator the real dispatch breakdown
 * uses, which is what the handoff means by "same data as prompt anatomy": these
 * numbers and frame 8b's ANATOMIE DU PROMPT agree by construction rather than
 * by coincidence.
 *
 * DATA GAPS ARE EM-DASHES. A spec that does not exist keeps its row — the row
 * is the *promise* "the spec goes in the prompt" — but the check glyph becomes
 * a minus and the value an em-dash. Never `0 tok`. With no cited docs the
 * doc rows simply do not exist, and with nothing at all the band folds to its
 * label line (`StrataBand` has no min-height and no padding floor).
 */
export interface ContextRailProps {
  tokens: ChatContextTokens;
}

function ContextRow({
  available,
  label,
  value,
}: {
  available: boolean;
  label: React.ReactNode;
  value: string;
}) {
  const Icon = available ? Check : Minus;
  return (
    <span className="flex items-center gap-[7px] text-[12.5px] text-foreground">
      <Icon
        size={12}
        aria-hidden="true"
        className={
          available
            ? "shrink-0 text-strata-live-deep"
            : "shrink-0 text-muted-foreground"
        }
      />
      {label}
      <Mono size={10} tone="next-mid" className="ml-auto shrink-0">
        {value}
      </Mono>
    </span>
  );
}

export function ContextRail({ tokens }: ContextRailProps) {
  const specValue =
    tokens.spec === null ? "—" : `${formatTokens(tokens.spec)} tok`;
  const memoryValue =
    tokens.memory === null ? "—" : `${formatTokens(tokens.memory)} tok`;

  // Nothing measurable at all — the band folds to its label line rather than
  // printing three em-dashes and calling that context.
  const empty =
    tokens.spec === null &&
    tokens.memory === null &&
    tokens.citedDocs.length === 0;

  return (
    <StrataBand
      stratum="next"
      gap={8}
      className="rounded-[14px] px-[15px] py-[13px]"
    >
      <BandHeader stratum="next" label="Contexte" labelSize={12} standalone />

      {empty ? null : (
        // A fragment, not a wrapper div: the band is a flex column and an
        // extra element would swallow its `gap` between these rows.
        <>
          <ContextRow
            available={tokens.spec !== null}
            label="Spec projet"
            value={specValue}
          />
          <ContextRow
            available={tokens.memory !== null}
            label="Mémoire"
            value={memoryValue}
          />
          {tokens.citedDocs.map((doc) => (
            // The frame drops the ` tok` unit after the first two rows.
            <span
              key={doc.id}
              data-testid="chat-context-doc"
              className="flex items-center gap-[7px] text-[12.5px] text-foreground"
            >
              <AtSign
                size={12}
                aria-hidden="true"
                className="shrink-0 text-strata-next-mid"
              />
              <Mono size={11.5} tone="ink" clamp={1}>
                {`@${doc.originalFilename}`}
              </Mono>
              <Mono size={10} tone="next-mid" className="ml-auto shrink-0">
                {formatTokens(doc.tokens)}
              </Mono>
            </span>
          ))}
        </>
      )}
    </StrataBand>
  );
}
