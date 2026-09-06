/**
 * Typed keys: `t("Nav.entries.tikcets")` is a compile error, `useLocale()`
 * returns `UiLocale`. The augmentation targets `next-intl`, as its docs
 * prescribe; `use-intl` picks it up through the re-export.
 */
import type en from "./messages/en.json";
import type { UiLocale } from "./locales";

declare module "next-intl" {
  interface AppConfig {
    Locale: UiLocale;
    Messages: typeof en;
  }
}
