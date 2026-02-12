"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  Hammer,
  Search,
  CheckCircle2,
  Loader2,
} from "lucide-react";

interface EpicActions_Epic {
  id: string;
  status: string;
  title: string;
}

interface AgentSession {
  id: string;
  status: string;
  mode: string;
}

interface EpicActionsProps {
  epic: EpicActions_Epic;
  dispatching: boolean;
  isRunning: boolean;
  activeSessions: AgentSession[];
  onSendToDev: (comment?: string) => Promise<unknown>;
  onSendToReview: (types: string[]) => Promise<unknown>;
  onApprove: () => Promise<unknown>;
}

export function EpicActions({
  epic,
  dispatching,
  isRunning,
  activeSessions,
  onSendToDev,
  onSendToReview,
  onApprove,
}: EpicActionsProps) {
  const [sendToDevOpen, setSendToDevOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [devComment, setDevComment] = useState("");
  const [reviewTypes, setReviewTypes] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);

  const status = epic.status;
  const canSendToDev = ["backlog", "todo", "in_progress"].includes(status);
  const canSendToDevFromReview = status === "review";
  const canReview = status === "review";
  const canApprove = status === "review";

  async function handleSendToDev() {
    try {
      await onSendToDev(devComment.trim() || undefined);
      setSendToDevOpen(false);
      setDevComment("");
    } catch {
      // error handled by parent
    }
  }

  async function handleSendToDevFromReview() {
    if (!devComment.trim()) return;
    try {
      await onSendToDev(devComment.trim());
      setSendToDevOpen(false);
      setDevComment("");
    } catch {
      // error handled by parent
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
      await onSendToReview(Array.from(reviewTypes));
      setReviewOpen(false);
      setReviewTypes(new Set());
    } catch {
      // error handled by parent
    }
  }

  async function handleApprove() {
    setApproving(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {isRunning && (
        <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30">
          <Loader2 className="h-3 w-3 animate-spin" />
          Agent running
        </Badge>
      )}

      {(canSendToDev || canSendToDevFromReview) && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDevComment("");
            setSendToDevOpen(true);
          }}
          disabled={dispatching || isRunning}
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
            setReviewTypes(new Set());
            setReviewOpen(true);
          }}
          disabled={dispatching || isRunning}
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
          disabled={approving || dispatching || isRunning}
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
          <Textarea
            value={devComment}
            onChange={(e) => setDevComment(e.target.value)}
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
                dispatching ||
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
          <div className="space-y-3">
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
              disabled={dispatching || reviewTypes.size === 0}
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
  );
}
