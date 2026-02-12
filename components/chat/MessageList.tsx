"use client";

import { useEffect, useRef, useState } from "react";
import { User, Bot, X } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatAttachment } from "@/hooks/useChat";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  createdAt: string;
}

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  streamStatus?: string | null;
}

export function MessageList({ messages, loading, streamStatus }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; alt: string } | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!lightboxImage) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxImage(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [lightboxImage]);

  if (loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading messages...
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center mt-8">
        Start a conversation to brainstorm your project with Claude
      </div>
    );
  }

  return (
    <>
      <div className="p-3 space-y-4">
        {messages.map((msg) => (
          <div key={msg.id} className="flex gap-2">
            <div className="shrink-0 mt-0.5">
              {msg.role === "user" ? (
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-3 w-3" />
                </div>
              ) : (
                <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
                  <Bot className="h-3 w-3" />
                </div>
              )}
            </div>
            <div className="flex-1 text-sm">
              {msg.content ? (
                <MarkdownContent content={msg.content} />
              ) : (
                <span className="animate-pulse text-muted-foreground">{streamStatus || "..."}</span>
              )}
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {msg.attachments.map((att) => (
                    <button
                      key={att.id}
                      onClick={() => setLightboxImage({ url: att.url, alt: att.fileName })}
                      className="block rounded-md overflow-hidden border border-border hover:border-primary transition-colors cursor-pointer"
                      type="button"
                    >
                      <img
                        src={att.url}
                        alt={att.fileName}
                        loading="lazy"
                        className="max-h-48 max-w-64 object-contain bg-muted"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Lightbox overlay */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setLightboxImage(null)}
        >
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
            type="button"
          >
            <X className="h-6 w-6" />
          </button>
          <img
            src={lightboxImage.url}
            alt={lightboxImage.alt}
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
