"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, X } from "lucide-react";

import {
  AvatarSquare,
  BandHeader,
  Mono,
  PillButton,
  SelectPill,
  StrataBand,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { NamedAgent } from "@/hooks/useAgentConfig";

import { agentInitials, agentTone } from "./agent-initials";

/**
 * FALLBACK LIST — a composite's ordered members, and the one place they are
 * edited.
 *
 * NO DRAG AND DROP. The Piscine rules forbid it app-wide and `@dnd-kit/*` is
 * imported by nothing; ordering is done with explicit move-up / move-down
 * buttons, which is also the only form of re-ordering a keyboard can reach.
 *
 * THE RANK IS THE POINT, so it is printed. Position 1 runs first, every failed
 * attempt moves one row down, and the length of the list is the run's attempt
 * budget — a reader who cannot see the numbers cannot predict the run.
 *
 * `data-testid` reaches the DOM here only because `SelectPill` and
 * `PillButton` spread `...rest` and the plain `<button>`s below are plain
 * `<button>`s. It would NOT reach it through `StrataBand`, `BandHeader`,
 * `Mono` or `FieldKicker`, none of which forward unknown props — which is why
 * the ids sit on elements this file owns.
 */
export interface CompositeMembersBandProps {
  /** Members of the composite being edited, in rank order. */
  members: NamedAgent["members"];
  /** Every simple agent — the pool the "add" menu offers. */
  candidates: NamedAgent[];
  disabled: boolean;
  /** True when this composite currently answers "Default agent". */
  isDefault: boolean;
  onChange: (memberIds: string[]) => void;
  onToggleDefault: (next: boolean) => void;
}

export function CompositeMembersBand({
  members,
  candidates,
  disabled,
  isDefault,
  onChange,
  onToggleDefault,
}: CompositeMembersBandProps) {
  const uid = useId();
  const t = useTranslations("AgentsWorkshop");
  const memberIds = members.map((member) => member.id);
  const chosen = new Set(memberIds);
  const addable = candidates.filter((candidate) => !chosen.has(candidate.id));

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= memberIds.length) return;
    const next = [...memberIds];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <StrataBand stratum="land" density="full" gap={10}>
      <BandHeader
        stratum="land"
        labelSize={12}
        label={t("composite.membersLabel")}
        meta={t("composite.membersMeta")}
      />

      <ol
        data-testid="composite-member-list"
        className="flex flex-col gap-[6px]"
      >
        {members.map((member, index) => (
          <li
            key={member.id}
            data-testid={`composite-member-${member.id}`}
            className="flex min-w-0 items-center gap-[9px] rounded-[10px] bg-card px-[11px] py-[8px]"
          >
            <Mono
              size={11}
              weight={700}
              tone="ink"
              className="w-[16px] shrink-0 tabular-nums"
            >
              {index + 1}
            </Mono>
            <AvatarSquare
              label={agentInitials(member.name)}
              tone={agentTone(member.id)}
              size={30}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-sans text-[13px] font-semibold text-foreground">
                {member.name}
              </span>
              <Mono size={10} tone="muted" clamp={1}>
                {t("roster.providerLine", {
                  provider: member.provider,
                  model: member.model || t("common.cliDefault"),
                })}
              </Mono>
            </span>
            <span className="flex shrink-0 items-center gap-[3px]">
              <IconControl
                label={t("composite.moveUp", { name: member.name })}
                testId={`composite-member-up-${member.id}`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={13} aria-hidden="true" />
              </IconControl>
              <IconControl
                label={t("composite.moveDown", { name: member.name })}
                testId={`composite-member-down-${member.id}`}
                disabled={disabled || index === members.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={13} aria-hidden="true" />
              </IconControl>
              <IconControl
                label={t("composite.remove", { name: member.name })}
                testId={`composite-member-remove-${member.id}`}
                // The LAST member cannot be removed here: the server refuses
                // an empty composite, and a control that can only fail is
                // worse than one that says why.
                disabled={disabled || members.length === 1}
                title={
                  members.length === 1
                    ? t("composite.keepOne")
                    : t("composite.remove", { name: member.name })
                }
                onClick={() =>
                  onChange(memberIds.filter((id) => id !== member.id))
                }
              >
                <X size={13} aria-hidden="true" />
              </IconControl>
            </span>
          </li>
        ))}
      </ol>

      {/* Wraps below `sm`: two pills and a label do not fit one 390px row. */}
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[8px]">
        <SelectPill
          tone="ink"
          fill="card"
          data-testid="composite-add-member"
          disabled={disabled || addable.length === 0}
          label={
            addable.length === 0
              ? t("composite.noAgentLeft")
              : t("composite.addMember")
          }
        >
          {addable.map((candidate) => (
            <DropdownMenuItem
              key={candidate.id}
              onSelect={() => onChange([...memberIds, candidate.id])}
            >
              {t("identity.candidate", {
                name: candidate.name,
                model: candidate.model || t("common.cliDefault"),
              })}
            </DropdownMenuItem>
          ))}
        </SelectPill>

        <PillButton
          variant={isDefault ? "filled" : "outline"}
          outlineTone="neutral"
          size="sm"
          data-testid="composite-default-toggle"
          aria-pressed={isDefault}
          aria-describedby={`${uid}-default-hint`}
          disabled={disabled}
          onClick={() => onToggleDefault(!isDefault)}
        >
          {isDefault ? t("composite.isDefault") : t("composite.makeDefault")}
        </PillButton>
      </div>

      <p
        id={`${uid}-default-hint`}
        className="font-sans text-[11.5px] leading-[1.5] text-strata-land-mid"
      >
        {t("composite.defaultHint")}
      </p>
    </StrataBand>
  );
}

/**
 * A square icon button with a real accessible name and a visible focus ring.
 *
 * Local rather than reached for from the barrel because these three are the
 * only controls of their shape in the workshop. The ring is the half a
 * class-presence sweep cannot prove: `outline-none` followed by an explicit
 * `focus-visible:outline-*` is what actually paints, and both themes resolve
 * `--ring` from app/globals.css.
 */
function IconControl({
  label,
  testId,
  disabled,
  title,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  disabled: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] border border-border bg-card text-muted-foreground outline-none hover:border-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
