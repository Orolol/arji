"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { MarkdownContent } from "./MarkdownContent";
import { ImageLightbox, type LightboxImage } from "@/components/shared/ImageLightbox";
import type { ChatAttachment } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

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
  const t = useTranslations("ChatLegacy");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (loading) {
    return (
      <div className="px-[18px] py-[18px] text-[13.5px] text-muted-foreground">
        {t("messages.loading")}
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="mt-8 px-[18px] text-center text-[13.5px] text-muted-foreground">
        {t("messages.empty")}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-[14px] px-[18px] py-[18px]">
        {messages.map((msg) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              data-role={msg.role}
              className={cn(
                "flex flex-col gap-2",
                isUser
                  ? "max-w-[80%] self-end rounded-[12px] rounded-br-[4px] bg-agent-bg px-[14px] py-[11px] text-[13.5px] leading-[1.55]"
                  : "max-w-[88%] self-start text-[13.5px] leading-[1.6]",
              )}
            >
              <div>
                {msg.content ? (
                  <MarkdownContent content={msg.content} />
                ) : (
                  <span className="animate-pulse text-muted-foreground">
                    {streamStatus || "..."}
                  </span>
                )}
              </div>
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {msg.attachments.map((att) => (
                    <button
                      key={att.id}
                      onClick={() => setLightboxImage({ url: att.url, alt: att.fileName })}
                      className="block overflow-hidden rounded-[8px] border border-border transition-colors hover:border-primary"
                      type="button"
                    >
                      <img
                        src={att.url}
                        alt={att.fileName}
                        loading="lazy"
                        className="max-h-48 max-w-64 bg-muted object-contain"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </>
  );
}
