"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import {
  SETTING_FIELDS,
  readEditors,
  type EditorValue,
  type SettingsData,
} from "./settings-fields";

/**
 * Draft-and-commit for the two batched settings tabs.
 *
 * ONE read, ONE write. `GET /api/settings` on mount (a scan of a small
 * key/value table — the page never polls it), then a single
 * `PATCH /api/settings` carrying every dirty key. The route validates all
 * entries before writing any and upserts in one transaction, so a batch is
 * atomic: one bad key rejects the lot, and the draft stays on screen with the
 * server's own message.
 *
 * DIRTY IS AN EDIT, NOT A TOUCH. `set` compares against the loaded editor
 * value and DELETES the key when they match, so a there-and-back edit
 * un-dirties the form and `Save` goes back to disabled.
 *
 * `agent_max_concurrent` has a second editor (`LimitsView`), which is why the
 * hook re-reads on mount and caches nothing across navigations.
 *
 * ITS FOUR SENTENCES COME FROM THE CATALOGUE, resolved HERE. This is a hook,
 * so it runs inside a render and may hold a translator — what it may not do is
 * hoist one to module scope, which is why the refusal a `SETTING_FIELDS` spec
 * returns is a KEY (`errorKey`) and this is where the key becomes a sentence.
 * The namespace-less translator is the one that takes those full dotted paths.
 * A message the SERVER wrote (`payload.error`) is passed through untouched:
 * the route composed it, not the catalogue.
 */
export interface SettingsDraft {
  /** The first GET has landed (successfully or not). */
  loaded: boolean;
  /** The GET failed: render placeholders, disable Save, say so. */
  loadFailed: boolean;
  /** Raw server payload, for the derivations no spec covers (blast radius). */
  data: SettingsData;
  /** Server-computed fallbacks the browser cannot derive (projects_root). */
  defaults: SettingsData;
  /** Editor value for a key: the pending edit if any, else what was loaded. */
  value: (key: string) => EditorValue;
  /** Editor value as a string — text fields and segments. */
  text: (key: string) => string;
  /** Editor value as a boolean — toggles. */
  flag: (key: string) => boolean;
  set: (key: string, next: EditorValue) => void;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<void>;
  discard: () => void;
  message: string | null;
  messageTone: "muted" | "danger";
  /** For a band that needs to speak (a per-card save on a batched tab). */
  setMessage: (message: string | null, tone?: "muted" | "danger") => void;
}

export function useSettingsDraft(): SettingsDraft {
  const t = useTranslations();
  const loadFailedMessage = t("Settings.draft.loadFailed");
  const savedMessage = t("Settings.draft.saved");
  const saveRefusedMessage = t("Settings.draft.saveRefused");
  const saveOfflineMessage = t("Settings.draft.saveOffline");

  const [data, setData] = useState<SettingsData>({});
  const [defaults, setDefaults] = useState<SettingsData>({});
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Record<string, EditorValue>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessageState] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"muted" | "danger">("muted");

  const editors = useMemo(() => readEditors(data), [data]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then(async (response) => {
        if (!response.ok) throw new Error("settings read failed");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const next = payload?.data;
        setData(next && typeof next === "object" ? (next as SettingsData) : {});
        const serverDefaults = payload?.defaults;
        setDefaults(
          serverDefaults && typeof serverDefaults === "object"
            ? (serverDefaults as SettingsData)
            : {},
        );
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Never render built-in defaults as if they were stored values.
        setLoaded(true);
        setLoadFailed(true);
        setMessageState(loadFailedMessage);
        setMessageTone("danger");
      });
    return () => {
      cancelled = true;
    };
  }, [loadFailedMessage]);

  const value = useCallback(
    (key: string): EditorValue =>
      key in draft ? draft[key] : (editors[key] ?? ""),
    [draft, editors],
  );

  const set = useCallback(
    (key: string, next: EditorValue) => {
      setMessageState(null);
      setDraft((current) => {
        const loadedValue = editors[key];
        if (Object.is(next, loadedValue)) {
          if (!(key in current)) return current;
          const { [key]: _dropped, ...rest } = current;
          return rest;
        }
        if (Object.is(current[key], next)) return current;
        return { ...current, [key]: next };
      });
    },
    [editors],
  );

  const discard = useCallback(() => {
    setDraft({});
    setMessageState(null);
    setMessageTone("muted");
  }, []);

  const setMessage = useCallback(
    (next: string | null, tone: "muted" | "danger" = "muted") => {
      setMessageState(next);
      setMessageTone(tone);
    },
    [],
  );

  const save = useCallback(async () => {
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(draft)) {
      const spec = SETTING_FIELDS[key];
      if (!spec) continue;
      const parsed = spec.parse(draft[key]);
      if ("errorKey" in parsed) {
        // Refuse the whole batch, exactly as the route does, and keep the
        // user's text on screen: a reformatted value next to a failure would
        // imply something that was never persisted.
        setMessageState(t(parsed.errorKey, parsed.errorValues));
        setMessageTone("danger");
        return;
      }
      if ("omit" in parsed) continue;
      body[key] = parsed.value;
    }

    if (Object.keys(body).length === 0) {
      setDraft({});
      setMessageState(null);
      setMessageTone("muted");
      return;
    }

    setSaving(true);
    setMessageState(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessageState(
          typeof payload?.error === "string" ? payload.error : saveRefusedMessage,
        );
        setMessageTone("danger");
        return;
      }
      // Feed the stored values back through the readers: that is what shows a
      // clamped breaker, a re-joined pattern list and reformatted verify JSON.
      setData((current) => ({ ...current, ...body }));
      setDraft({});
      setMessageState(savedMessage);
      setMessageTone("muted");
    } catch {
      setMessageState(saveOfflineMessage);
      setMessageTone("danger");
    } finally {
      setSaving(false);
    }
  }, [draft, t, savedMessage, saveRefusedMessage, saveOfflineMessage]);

  return {
    loaded,
    loadFailed,
    data,
    defaults,
    value,
    text: (key) => {
      const v = value(key);
      return typeof v === "string" ? v : v ? "true" : "";
    },
    flag: (key) => value(key) === true,
    set,
    dirty: Object.keys(draft).length > 0,
    saving,
    save,
    discard,
    message,
    messageTone,
    setMessage,
  };
}
