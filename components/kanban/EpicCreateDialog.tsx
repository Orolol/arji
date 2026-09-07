"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { createId } from "@/lib/utils/nanoid";
import {
  buildManualEpicPayload,
  createEmptyEpicDraft,
  createEmptyUserStory,
  formatEpicCreateError,
  validateManualEpicDraft,
  type ManualEpicDraft,
  type ManualUserStoryDraft,
} from "@/lib/epics/manual-epic-form";

interface EpicCreateDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional editable seed used by flows such as friction conversion. */
  initialDraft?: ManualEpicDraft;
  /** When present, creation atomically closes and links this friction. */
  frictionId?: string;
  dialogTitle?: string;
  dialogDescription?: string;
  submitLabel?: string;
  /** Fired after the epic lands so the board can refresh. */
  onCreated?: (epicId: string) => void;
}

/**
 * Direct epic authoring: title, description and as many user stories as the
 * user wants, written by hand and posted straight to the epics route.
 *
 * No agent is involved — this is the fast path for someone who already knows
 * what the ticket says. Brainstorming still lives in the unified chat panel.
 */
export function EpicCreateDialog({
  projectId,
  open,
  onOpenChange,
  initialDraft,
  frictionId,
  dialogTitle,
  dialogDescription,
  submitLabel,
  onCreated,
}: EpicCreateDialogProps) {
  const t = useTranslations("Kanban");
  const [draft, setDraft] = useState<ManualEpicDraft>(createEmptyEpicDraft);
  const [collapsedStories, setCollapsedStories] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Field errors stay hidden until the first submit attempt. */
  const [showErrors, setShowErrors] = useState(false);
  /** Story whose title input should take focus once it has been rendered. */
  const [pendingFocusKey, setPendingFocusKey] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const storyTitleRefs = useRef(new Map<string, HTMLInputElement | null>());

  const validation = validateManualEpicDraft(draft);

  useEffect(() => {
    if (!open) return;
    setDraft(
      initialDraft
        ? {
            ...initialDraft,
            userStories: initialDraft.userStories.map((story) => ({ ...story })),
          }
        : createEmptyEpicDraft(),
    );
    setCollapsedStories({});
    setError(null);
    setShowErrors(false);
  }, [initialDraft, open]);

  /**
   * Sends the caret into a freshly added story block.
   *
   * New blocks append to the bottom of the same scrolling body that made a
   * blocked submit invisible: past a few stories, "Add user story" pushes the
   * block below the fold and the only visible change is the counter, so the
   * button reads as dead. Focus scrolls the block into view and puts the caret
   * where the user was going to type anyway. Deferred to an effect because the
   * input does not exist until the render that adds it has committed.
   */
  useEffect(() => {
    if (!pendingFocusKey) return;
    storyTitleRefs.current.get(pendingFocusKey)?.focus();
    setPendingFocusKey(null);
  }, [pendingFocusKey]);

  function resetForm() {
    setDraft(createEmptyEpicDraft());
    setCollapsedStories({});
    setError(null);
    setShowErrors(false);
    setPendingFocusKey(null);
    storyTitleRefs.current.clear();
  }

  function handleOpenChange(next: boolean) {
    if (submitting) return;
    if (!next) resetForm();
    onOpenChange(next);
  }

  function addUserStory() {
    const story = createEmptyUserStory(createId());
    setDraft((prev) => ({ ...prev, userStories: [...prev.userStories, story] }));
    setPendingFocusKey(story.key);
  }

  function removeUserStory(key: string) {
    setDraft((prev) => ({
      ...prev,
      userStories: prev.userStories.filter((story) => story.key !== key),
    }));
    setCollapsedStories((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    storyTitleRefs.current.delete(key);
  }

  /**
   * Puts the caret on the first thing the user has to fix.
   *
   * The fields scroll inside the dialog body while Create sits in the footer
   * outside it, so a blocked submit can otherwise render its message off-screen
   * and read as a dead button. Focusing brings the field into view and names it
   * to a screen reader, which `aria-invalid` alone does not.
   */
  function focusFirstInvalidField() {
    if (validation.titleError) {
      titleRef.current?.focus();
      return;
    }
    if (validation.descriptionError) {
      descriptionRef.current?.focus();
      return;
    }
    // Draft order, not object order: the user is sent to the topmost offender.
    const firstInvalid = draft.userStories.find(
      (story) => validation.storyErrors[story.key]
    );
    if (!firstInvalid) return;
    // The story title input lives in the block header, so it is reachable even
    // when the block is collapsed — no need to expand it first.
    storyTitleRefs.current.get(firstInvalid.key)?.focus();
  }

  function updateUserStory(
    key: string,
    field: keyof Omit<ManualUserStoryDraft, "key">,
    value: string
  ) {
    setDraft((prev) => ({
      ...prev,
      userStories: prev.userStories.map((story) =>
        story.key === key ? { ...story, [field]: value } : story
      ),
    }));
  }

  async function handleSubmit() {
    if (submitting) return;
    if (!validation.valid) {
      setShowErrors(true);
      focusFirstInvalidField();
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/epics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildManualEpicPayload(draft, frictionId ? { frictionId } : {}),
        ),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        // The dialog stays open with the draft intact so a failed request
        // never costs the user what they typed.
        setError(formatEpicCreateError(json));
        return;
      }

      const epicId = json.data?.id as string | undefined;
      resetForm();
      onOpenChange(false);
      onCreated?.(epicId ?? "");
    } catch {
      setError(t("epicCreate.errors.create"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="rounded-[14px] shadow-[0_18px_40px_rgba(58,48,44,.14)] sm:max-w-[560px]"
        data-testid="epic-create-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold">
            {dialogTitle ?? t("epicCreate.title")}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {dialogDescription ?? t("epicCreate.description")}
          </DialogDescription>
        </DialogHeader>

        <div
          className="max-h-[60vh] space-y-4 overflow-y-auto py-2 pr-1"
          data-testid="epic-create-body"
        >
          <div>
            <label
              htmlFor="epic-title"
              className="mb-1 block text-[12.5px] text-muted-foreground"
            >
              {t("epicCreate.titleLabel")}
            </label>
            <Input
              id="epic-title"
              ref={titleRef}
              value={draft.title}
              onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
              placeholder={t("epicCreate.titlePlaceholder")}
              aria-invalid={showErrors && validation.titleError !== null}
              aria-describedby={
                showErrors && validation.titleError ? "epic-title-error" : undefined
              }
              data-testid="epic-title-input"
              autoFocus
            />
            {showErrors && validation.titleError && (
              <p
                id="epic-title-error"
                role="alert"
                className="mt-1 text-[12px] text-destructive"
                data-testid="epic-title-error"
              >
                {validation.titleError}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="epic-description"
              className="mb-1 block text-[12.5px] text-muted-foreground"
            >
              {t("epicCreate.descriptionLabel")}
            </label>
            <Textarea
              id="epic-description"
              ref={descriptionRef}
              value={draft.description}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder={t("epicCreate.descriptionPlaceholder")}
              rows={4}
              aria-invalid={showErrors && validation.descriptionError !== null}
              aria-describedby={
                showErrors && validation.descriptionError
                  ? "epic-description-error"
                  : undefined
              }
              data-testid="epic-description-input"
            />
            {showErrors && validation.descriptionError && (
              <p
                id="epic-description-error"
                role="alert"
                className="mt-1 text-[12px] text-destructive"
                data-testid="epic-description-error"
              >
                {validation.descriptionError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] text-muted-foreground">
                {draft.userStories.length > 0
                  ? t("epicCreate.userStoriesCount", {
                      count: draft.userStories.length,
                    })
                  : t("epicCreate.userStories")}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addUserStory}
                className="h-[27px] rounded-[7px] text-[12.5px]"
                data-testid="add-user-story"
              >
                <Plus className="mr-1 h-3 w-3" />
                {t("epicCreate.addUserStory")}
              </Button>
            </div>

            {draft.userStories.length === 0 && (
              <p className="text-[12.5px] text-meta">
                {t("epicCreate.noStories")}
              </p>
            )}

            {draft.userStories.map((story, index) => {
              const collapsed = collapsedStories[story.key] ?? false;
              const storyError = showErrors ? validation.storyErrors[story.key] : undefined;
              const storyErrorId = `user-story-error-${story.key}`;

              return (
                <div
                  key={story.key}
                  className={cn(
                    "rounded-[10px] border border-border bg-card p-[10px]",
                    storyError && "border-destructive/50"
                  )}
                  data-testid="user-story-block"
                >
                  <div className="flex items-center gap-[6px]">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedStories((prev) => ({
                          ...prev,
                          [story.key]: !collapsed,
                        }))
                      }
                      aria-expanded={!collapsed}
                      aria-label={
                        collapsed
                          ? t("epicCreate.expandStory", { index: index + 1 })
                          : t("epicCreate.collapseStory", { index: index + 1 })
                      }
                      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {collapsed ? (
                        <ChevronRight className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <span className="shrink-0 text-[12px] text-meta">#{index + 1}</span>
                    <Input
                      value={story.title}
                      ref={(node) => {
                        storyTitleRefs.current.set(story.key, node);
                      }}
                      onChange={(e) => updateUserStory(story.key, "title", e.target.value)}
                      placeholder={t("epicCreate.storyTitlePlaceholder")}
                      aria-label={t("epicCreate.storyTitleLabel", {
                        index: index + 1,
                      })}
                      aria-invalid={Boolean(storyError)}
                      aria-describedby={storyError ? storyErrorId : undefined}
                      className="h-[30px] text-[13px]"
                      data-testid="user-story-title-input"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeUserStory(story.key)}
                      aria-label={t("epicCreate.removeStory", {
                        index: index + 1,
                      })}
                      className="h-[27px] w-[27px] shrink-0 rounded-[7px] p-0 text-muted-foreground hover:text-destructive"
                      data-testid="remove-user-story"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {storyError && (
                    <p
                      id={storyErrorId}
                      role="alert"
                      className="mt-1 pl-[28px] text-[12px] text-destructive"
                    >
                      {storyError}
                    </p>
                  )}

                  {!collapsed && (
                    <div className="mt-[8px] space-y-2 pl-[28px]">
                      <Textarea
                        value={story.description}
                        onChange={(e) =>
                          updateUserStory(story.key, "description", e.target.value)
                        }
                        placeholder={t("epicCreate.storyDescriptionPlaceholder")}
                        aria-label={t("epicCreate.storyDescriptionLabel", {
                          index: index + 1,
                        })}
                        rows={2}
                        className="text-[13px]"
                        data-testid="user-story-description-input"
                      />
                      <Textarea
                        value={story.acceptanceCriteria}
                        onChange={(e) =>
                          updateUserStory(story.key, "acceptanceCriteria", e.target.value)
                        }
                        placeholder={t("epicCreate.storyCriteriaPlaceholder")}
                        aria-label={t("epicCreate.storyCriteriaLabel", {
                          index: index + 1,
                        })}
                        rows={3}
                        className="text-[13px]"
                        data-testid="user-story-criteria-input"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        </div>

        {/*
          Outside the scrolling body on purpose: a rejection concerns the whole
          submit, so it belongs next to the button that triggered it rather than
          below however many story blocks the user added.
        */}
        {error && (
          <p
            role="alert"
            className="text-xs text-destructive"
            data-testid="epic-create-error"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="epic-create-submit"
          >
            {submitting && (
              <Loader2
                className="mr-1 h-3 w-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
                data-testid="epic-create-spinner"
              />
            )}
            {submitLabel ?? t("epicCreate.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
