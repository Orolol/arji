import { useLocale } from "next-intl";
import { StatNumeral } from "@/components/piscine";
import { formatRelative } from "@/lib/i18n/format";

import { displayVersion, upperAge, type ReleaseRow } from "./derive";

export interface ReleaseStatTilesProps {
  loading: boolean;
  /** `releases[0]` — the API returns them createdAt DESC. */
  latest: ReleaseRow | null;
  /** Live count of CHECKED candidates, so the tile tracks the composer. */
  readyCount: number;
  releaseCount: number;
  /** The version being composed, bare (no leading `v`). */
  version: string;
}

const TILE =
  "flex flex-1 flex-col gap-[3px] rounded-[14px] bg-card px-[16px] py-[13px]";

/**
 * The three white tiles above HISTORY.
 *
 * A value nobody knows yet is an em-dash, never a zero — that is StatNumeral's
 * contract and the repo-wide convention. Once loading is done a genuine 0 is a
 * known fact and renders as 0.
 *
 * READY FOR is the screen's second loud colour (`--strata-live-deep`); nothing
 * else here is coloured.
 */
export function ReleaseStatTiles({
  loading,
  latest,
  readyCount,
  releaseCount,
  version,
}: ReleaseStatTilesProps) {
  const locale = useLocale();
  const age = latest ? upperAge(formatRelative(latest.createdAt, { locale })) : "";

  return (
    <div className="flex shrink-0 gap-[12px]">
      <div className={TILE} data-testid="release-stat-current">
        <StatNumeral
          size={22}
          captionStratum="card"
          value={latest ? displayVersion(latest.version) : null}
          caption={age ? `CURRENT · ${age}` : "CURRENT"}
        />
      </div>
      <div className={TILE} data-testid="release-stat-ready">
        <StatNumeral
          size={22}
          tone="live"
          captionStratum="card"
          value={loading ? null : readyCount}
          caption={`READY FOR v${version}`}
        />
      </div>
      <div className={TILE} data-testid="release-stat-shipped">
        <StatNumeral
          size={22}
          captionStratum="card"
          value={loading ? null : releaseCount}
          caption="RELEASES SHIPPED"
        />
      </div>
    </div>
  );
}
