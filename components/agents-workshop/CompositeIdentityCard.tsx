"use client";

import { useId } from "react";

import { FieldKicker, Mono, SurfaceCard } from "@/components/piscine";

import { FieldBoxInput } from "./FieldBox";

/**
 * A composite's identity row: NAME, and the size of its ladder.
 *
 * The CLI and MODEL fields of `AgentIdentityCard` are absent rather than
 * disabled, because a composite does not merely have them unset — it does not
 * have them at all. Rendering them greyed would say "not right now" about
 * something that is never true, and the memory of this codebase records
 * exactly that confusion (a dimmed control and the action's real availability
 * drifting apart).
 *
 * The member count is printed here because it IS the attempt budget: a
 * three-member composite gets three attempts per stage, and
 * `pipeline_max_attempts` does not apply to it.
 */
export interface CompositeIdentityCardProps {
  name: string;
  memberCount: number;
  disabled: boolean;
  onNameChange: (value: string) => void;
}

export function CompositeIdentityCard({
  name,
  memberCount,
  disabled,
  onNameChange,
}: CompositeIdentityCardProps) {
  const uid = useId();

  return (
    <SurfaceCard className="shrink-0 rounded-[14px] px-[18px] py-[14px]">
      <div className="flex flex-wrap items-end gap-x-[22px] gap-y-[14px]">
        <div className="flex min-w-[180px] flex-1 flex-col gap-[5px] lg:w-[280px] lg:flex-none">
          <FieldKicker stratum="card" size={10}>
            NAME
          </FieldKicker>
          <FieldBoxInput
            id={`${uid}-name`}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            aria-label="Name"
            placeholder="Composite name"
            disabled={disabled}
          />
        </div>

        <div className="flex min-w-[150px] flex-1 flex-col gap-[5px]">
          <FieldKicker stratum="card" size={10}>
            KIND
          </FieldKicker>
          <p
            data-testid="composite-kind-note"
            className="font-sans text-[12.5px] leading-[1.5] text-muted-foreground"
          >
            Composite —{" "}
            <Mono size={11} weight={700} tone="ink">
              {memberCount}
            </Mono>{" "}
            {memberCount === 1 ? "agent" : "agents"} in order, which is also
            this agent&apos;s attempt budget per stage.
          </p>
        </div>
      </div>
    </SurfaceCard>
  );
}
