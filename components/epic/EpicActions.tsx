"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/documents/MentionTextarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Hammer,
  Search,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { ProviderSelect, type ProviderType } from "@/components/shared/ProviderSelect";

interface EpicActions_Epic {
  id: string;
  status: string;
  title: string;
}

interface EpicActionsProps {
  projectId: string;
  epic: EpicActions_Epic;
  dispatching: boolean;
  isRunning: boolean;
  activeSessionId?: string | null;
  codexAvailable: boolean;
  codexInstalled?: boolean;
  onSendToDev: (comment?: string, provider?: ProviderType) => Promise<unknown>;
  onSendToReview: (types: string[], provider?: ProviderType) => Promise<unknown>;
  onApprove: () => Promise<unknown>;
  onActionError?: (error: unknown) => void;
}

export function EpicActions({
  projectId,
  epic,
  dispatching,
  isRunning,
  activeSessionId,
  codexAvailable,
  codexInstalled,
  onSendToDev,
  onSendToReview,
  onApprove,
  onActionError,
}: EpicActionsProps) {
  const [sendToDevOpen, setSendToDevOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [devComment, setDevComment] = useState("");
  const [devProvider, setDevProvider] = useState<ProviderType>("claude-code");
  const [reviewProvider, setReviewProvider] = useState<ProviderType>("claude-code");
  const [reviewTypes, setReviewTypes] = useState<Set<string>>(new Set(["feature_review"]));
  const [approving, setApproving] = useState(false);

  const status = epic.status;
  const canSendToDev = ["backlog", "todo", "in_progress"].includes(status);
  const canSendToDevFromReview = status === "review";
  const canReview = status === "review" || status === "done";
  const canApprove = status === "review";
  const actionsLocked = dispatching || isRunning;
  const lockMessage =
    isRunning && activeSessionId
      ? `Another agent is already running for this epic (#${activeSessionId.slice(0, 6)}).`
      : isRunning
        ? "Another agent is already running for this epic."
        : null;

  async function handleSendToDev() {
    try {
      await onSendToDev(devComment.trim() || undefined, devProvider);
      setSendToDevOpen(false);
      setDevComment("");
    } catch (error) {
      onActionError?.(error);
    }
  }

  async function handleSendToDevFromReview() {
    if (!devComment.trim()) return;
    try {
      await onSendToDev(devComment.trim(), devProvider);
      setSendToDevOpen(false);
      setDevComment("");
    } catch (error) {
      onActionError?.(error);
    }
  }

  function toggleReviewType(type: string) {
    setReviewTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  async function handleReview() {
    if (reviewTypes.size === 0) return;
    try {
      await onSendToReview(Array.from(reviewTypes), reviewProvider);
      setReviewOpen(false);
      setReviewTypes(new Set());
    } catch (error) {
      onActionError?.(error);
    }
  }

  async function handleApprove() {
    setApproving(true);
    try {
      await onApprove();
    } catch (error) {
      onActionError?.(error);
    } finally {
      setApproving(false);
    }
  }

  const lockedTooltip = isRunning
    ? "Agent is already running on this epic"
    : null;

  return (
    <TooltipProvider>
    <div className="flex items-center gap-2 flex-wrap">
      {isRunning && (
        <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30">
          <Loader2 className="h-3 w-3 animate-spin" />
          Agent running
        </Badge>
      )}
      {lockMessage && (
        <span className="text-xs text-muted-foreground">{lockMessage}</span>
      )}

      {(canSendToDev || canSendToDevFromReview) && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDevComment("");
            setSendToDevOpen(true);
          }}
          disabled={actionsLocked}
          className="h-7 text-xs"
        >
          <Hammer className="h-3 w-3 mr-1" />
          Send to Dev
        </Button>
      )}

      {canReview && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setReviewTypes(new Set(["feature_review"]));
            setReviewOpen(true);
          }}
          disabled={actionsLocked}
          className="h-7 text-xs"
        >
          <Search className="h-3 w-3 mr-1" />
          Agent Review
        </Button>
      )}

      {canApprove && (
        <Button
          size="sm"
          onClick={handleApprove}
          disabled={approving || actionsLocked}
          className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
        >
          {approving ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <CheckCircle2 className="h-3 w-3 mr-1" />
          )}
          Approve
        </Button>
      )}

      {/* Send to Dev Dialog */}
      <Dialog open={sendToDevOpen} onOpenChange={setSendToDevOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Epic to Dev</DialogTitle>
            <DialogDescription>
              {canSendToDevFromReview
                ? "Explain what needs to be fixed. This comment is required."
                : "Optionally add a comment for the agent before dispatching."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground">Provider:</span>
            <ProviderSelect
              value={devProvider}
              onChange={setDevProvider}
              codexAvailable={codexAvailable}
              codexInstalled={codexInstalled}
              className="w-40 h-8 text-xs"
            />
          </div>
          <MentionTextarea
            projectId={projectId}
            value={devComment}
            onValueChange={setDevComment}
            placeholder={
              canSendToDevFromReview
                ? "Describe what needs to be fixed..."
                : "Optional instructions for the agent..."
            }
            rows={4}
            className="text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendToDevOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={
                canSendToDevFromReview
                  ? handleSendToDevFromReview
                  : handleSendToDev
              }
              disabled={
                actionsLocked ||
                (canSendToDevFromReview && !devComment.trim())
              }
            >
              {dispatching ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Hammer className="h-4 w-4 mr-1" />
              )}
              Dispatch Agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Agent Review Dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Epic Agent Review</DialogTitle>
            <DialogDescription>
              Select the review types to run on this epic. Each selected type dispatches a separate agent.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground">Provider:</span>
            <ProviderSelect
              value={reviewProvider}
              onChange={setReviewProvider}
              codexAvailable={codexAvailable}
              codexInstalled={codexInstalled}
              className="w-40 h-8 text-xs"
            />
          </div>
          <div className="space-y-3">
            <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 cursor-pointer">
              <input
                type="checkbox"
                checked={reviewTypes.has("feature_review")}
                onChange={() => toggleReviewType("feature_review")}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">Feature Review</p>
                <p className="text-xs text-muted-foreground">
                  Verifies feature completeness against acceptance criteria using all available tools
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 cursor-pointer">
              <input
                type="checkbox"
                checked={reviewTypes.has("security")}
                onChange={() => toggleReviewType("security")}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">Security</p>
                <p className="text-xs text-muted-foreground">
                  OWASP top 10, input validation, auth/authz, secrets exposure
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 cursor-pointer">
              <input
                type="checkbox"
                checked={reviewTypes.has("code_review")}
                onChange={() => toggleReviewType("code_review")}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">Code Review</p>
                <p className="text-xs text-muted-foreground">
                  Readability, DRY, error handling, performance, naming
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 cursor-pointer">
              <input
                type="checkbox"
                checked={reviewTypes.has("compliance")}
                onChange={() => toggleReviewType("compliance")}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">Compliance / Accessibility</p>
                <p className="text-xs text-muted-foreground">
                  WCAG accessibility, i18n readiness, license compliance
                </p>
              </div>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleReview}
              disabled={actionsLocked || reviewTypes.size === 0}
            >
              {dispatching ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Search className="h-4 w-4 mr-1" />
              )}
              Run Review ({reviewTypes.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
}
