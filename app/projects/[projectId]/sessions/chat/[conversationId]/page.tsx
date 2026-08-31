"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MessageList } from "@/components/chat/MessageList";
import {
  ArrowLeft,
  MessageSquare,
  Sparkles,
  RefreshCw,
  Calendar,
  Hash,
} from "lucide-react";
import { PROVIDER_LABELS } from "@/lib/agent-config/constants";
import { cn } from "@/lib/utils";

interface ConversationMeta {
  id: string;
  projectId: string;
  type: string;
  label: string;
  status: string | null;
  epicId: string | null;
  provider: string | null;
  namedAgentId: string | null;
  namedAgentName: string | null;
  createdAt: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: {
    id: string;
    fileName: string;
    mimeType: string;
    url: string;
  }[];
  createdAt: string;
}

export default function ChatDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const conversationId = params.conversationId as string;

  const [meta, setMeta] = useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Split so the effect can fetch without the state writes being visible in
  // its body: `fetchConversation` is pure I/O, `applyConversation` is the
  // state update, and both the mount effect and `fetchData` compose them.
  const fetchConversation = useCallback(
    () =>
      Promise.all([
        fetch(`/api/projects/${projectId}/conversations/${conversationId}`).then(
          (r) => r.json()
        ),
        fetch(
          `/api/projects/${projectId}/chat?conversationId=${conversationId}`
        ).then((r) => r.json()),
      ]),
    [projectId, conversationId]
  );

  const applyConversation = useCallback(
    (metaJson: { data?: ConversationMeta }, msgsJson: { data?: ChatMessage[] }) => {
      if (metaJson.data) setMeta(metaJson.data);
      if (msgsJson.data) setMessages(msgsJson.data);
    },
    []
  );

  const fetchData = useCallback(async () => {
    const [metaJson, msgsJson] = await fetchConversation();
    applyConversation(metaJson, msgsJson);
  }, [fetchConversation, applyConversation]);

  // `loading` derives from "no payload has arrived for this conversation yet",
  // which is what the synchronous `setLoading(true)` at the top of the effect
  // used to express — and it also stops the previous conversation's messages
  // from showing while the new one is still in flight.
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(
    null
  );
  const loading = loadedConversationId !== conversationId;

  useEffect(() => {
    let cancelled = false;
    void fetchConversation()
      .then(([metaJson, msgsJson]) => {
        if (!cancelled) applyConversation(metaJson, msgsJson);
      })
      .finally(() => {
        if (!cancelled) setLoadedConversationId(conversationId);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchConversation, applyConversation, conversationId]);

  // Auto-poll every 3s when status is "generating"
  useEffect(() => {
    if (meta?.status === "generating") {
      pollRef.current = setInterval(() => {
        fetchData();
      }, 3000);
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [meta?.status, fetchData]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }

  if (loading) {
    return (
      <div className="p-6 text-muted-foreground">Loading conversation...</div>
    );
  }

  if (!meta) {
    return (
      <div className="p-6">
        <Link
          href={`/projects/${projectId}/sessions`}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-4"
        >
          <ArrowLeft className="h-3 w-3" /> Back to sessions
        </Link>
        <p className="text-muted-foreground text-sm">Conversation not found</p>
      </div>
    );
  }

  const TypeIcon = meta.type === "epic" ? Sparkles : MessageSquare;
  const isGenerating = meta.status === "generating";

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-[16px] p-[24px]">
      {/* Back link */}
      <Link
        href={`/projects/${projectId}/sessions`}
        className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> Back to sessions
      </Link>

      {/* Identity line */}
      <div className="flex flex-wrap items-center gap-[10px]">
        {isGenerating ? (
          <span className="breathing-dot h-[7px] w-[7px]" />
        ) : (
          <TypeIcon className="h-4 w-4 text-meta" />
        )}
        <Badge
          variant="outline"
          className="rounded-full px-[8px] py-[1px] text-[11px] font-normal text-meta"
        >
          {meta.type}
        </Badge>
        {meta.status && (
          <Badge
            variant="outline"
            className={cn(
              "rounded-full px-[8px] py-[1px] text-[11px] font-normal",
              isGenerating
                ? "text-agent border-agent-border"
                : meta.status === "error"
                  ? "text-destructive border-destructive/30"
                  : "text-meta"
            )}
          >
            {meta.status}
          </Badge>
        )}
        {meta.namedAgentName ? (
          <Badge
            variant="outline"
            className="rounded-full px-[8px] py-[1px] text-[11px] font-normal text-meta"
          >
            {meta.namedAgentName}
          </Badge>
        ) : meta.provider && meta.provider !== "claude-code" ? (
          <Badge
            variant="outline"
            className="rounded-full px-[8px] py-[1px] text-[11px] font-normal uppercase tracking-wide text-meta"
          >
            {PROVIDER_LABELS[meta.provider as keyof typeof PROVIDER_LABELS] ??
              meta.provider}
          </Badge>
        ) : null}

        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-[31px] rounded-[8px] px-[12px] text-[13px]"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw
            className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      <h2 className="text-[18px] font-medium leading-[1.3]">{meta.label}</h2>

      {/* Key/value rows */}
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-4 border-t border-border-soft py-[11px]">
          <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Calendar className="h-[13px] w-[13px]" />
            Created
          </span>
          <span className="text-[13px]">
            {new Date(meta.createdAt).toLocaleDateString()}{" "}
            {new Date(meta.createdAt).toLocaleTimeString()}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 border-y border-border-soft py-[11px]">
          <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Hash className="h-[13px] w-[13px]" />
            Messages
          </span>
          <span className="font-mono text-[13px]">{messages.length}</span>
        </div>
      </div>

      {/* Message history */}
      <Card className="overflow-hidden rounded-[12px]">
        <MessageList
          messages={messages}
          loading={false}
          streamStatus={isGenerating ? "Generating..." : null}
        />
      </Card>
    </div>
  );
}
