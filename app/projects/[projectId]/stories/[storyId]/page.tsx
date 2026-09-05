"use client";

import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useStoryDetail } from "@/hooks/useStoryDetail";
import { useTicketComments } from "@/hooks/useTicketComments";
import { useAgentDispatch } from "@/hooks/useAgentDispatch";
import { StoryDetailPanel } from "@/components/story/StoryDetailPanel";
import { CommentThread } from "@/components/story/CommentThread";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";
import { Button } from "@/components/ui/button";
import { PermanentDeleteDialog } from "@/components/shared/PermanentDeleteDialog";
import { ToastStack } from "@/components/notifications/ToastStack";
import { useToastStack } from "@/components/notifications/useToastStack";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { isAgentAlreadyRunningError } from "@/lib/agents/client-error";

export default function StoryDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const storyId = params.storyId as string;
  const { toasts, raise, dismiss: dismissToast } = useToastStack();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingStory, setDeletingStory] = useState(false);
  const deleteInFlightRef = useRef(false);

  const {
    story,
    loading: storyLoading,
    updateStory,
    refresh: refreshStory,
  } = useStoryDetail(projectId, storyId);

  const {
    comments,
    loading: commentsLoading,
    addComment,
  } = useTicketComments(projectId, { kind: "story", storyId });

  const {
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    merge,
  } = useAgentDispatch(projectId, {
    kind: "story",
    storyId,
    epicId: story?.epicId,
  });

  /** Everything this page reports is a failure, so every toast is an error. */
  function addToast(message: string, href?: string) {
    raise("error", message, href ? { href } : undefined);
  }

  function handleAgentActionError(error: unknown) {
    if (isAgentAlreadyRunningError(error)) {
      addToast(
        error.message,
        error.sessionUrl || `/projects/${projectId}/sessions/${error.activeSessionId}`
      );
      return;
    }
    addToast(error instanceof Error ? error.message : "Failed to run agent action");
  }

  async function handleDeleteStory() {
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeletingStory(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/stories/${storyId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        addToast(data.error || "Failed to delete story");
        return;
      }

      setDeleteDialogOpen(false);
      router.push(`/projects/${projectId}?deleted=story`);
    } catch {
      addToast("Failed to delete story");
    } finally {
      deleteInFlightRef.current = false;
      setDeletingStory(false);
    }
  }

  if (storyLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!story) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-muted-foreground">Story not found</p>
        <Link
          href={`/projects/${projectId}`}
          className="text-sm text-primary hover:underline"
        >
          Back to board
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-3">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Board
        </Link>
        {story.epic && (
          <span className="text-sm text-muted-foreground">
            / {story.epic.title}
          </span>
        )}
        <div className="flex-1" />
        <AgentActionsBar
          projectId={projectId}
          target={{ kind: "story", story }}
          dispatching={dispatching}
          isRunning={isRunning}
          onSendToDev={async (comment, namedAgentId, resumeSessionId, pipeline) => {
            await sendToDev(comment, namedAgentId, resumeSessionId, pipeline);
            refreshStory();
          }}
          onSendToReview={async (types, namedAgentId, resumeSessionId) => {
            await sendToReview(types, namedAgentId, resumeSessionId);
          }}
          onComplete={async () => {
            // Story approval closes the story only; the epic closes through
            // its own merge. Thrown errors are caught by AgentActionsBar and
            // routed to onActionError.
            await merge();
            refreshStory();
          }}
          activeSessionId={activeSession?.id || null}
          onActionError={handleAgentActionError}
        />
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Story details */}
        <div className="w-1/2 border-r border-border overflow-y-auto">
          <StoryDetailPanel
            story={story}
            onUpdate={updateStory}
          />
          <div className="px-6 pb-6 space-y-2">
            <h4 className="text-sm font-medium text-destructive">Danger Zone</h4>
            <p className="text-xs text-muted-foreground">
              Permanently delete this user story and all dependent records.
            </p>
            <Button
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={deletingStory}
            >
              Delete User Story
            </Button>
          </div>
        </div>

        {/* Right: Comment thread */}
        <div className="w-1/2 flex flex-col overflow-hidden">
          <CommentThread
            projectId={projectId}
            comments={comments}
            loading={commentsLoading}
            onAddComment={addComment}
          />
        </div>
      </div>

      <ToastStack items={toasts} onDismiss={dismissToast} testId="story-toast" />

      <PermanentDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete User Story"
        description="Permanently delete this user story and its linked planning data."
        confirmLabel="Confirm Delete"
        deleting={deletingStory}
        onConfirm={handleDeleteStory}
      />
    </div>
  );
}
