"use client";

import { UsageScreen } from "@/components/usage/UsageScreen";

/**
 * Usage observatory (frame 8d). The whole screen lives in
 * `components/usage/UsageScreen.tsx`; this route is only the mount point.
 *
 * Kept a DEFAULT export: `__tests__/usage-page.test.tsx` imports it as one.
 */
export default function UsagePage() {
  return <UsageScreen />;
}
