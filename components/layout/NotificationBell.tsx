"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCircle2, XCircle } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications, type NotificationItem } from "@/hooks/useNotifications";
import { timeAgo } from "@/lib/utils/format-date";

function NotificationRow({
  notification,
  onNavigate,
}: {
  notification: NotificationItem;
  onNavigate: (url: string) => void;
}) {
  const isSuccess = notification.status === "completed";

  return (
    <button
      type="button"
      onClick={() => onNavigate(notification.targetUrl)}
      className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-band transition-colors rounded-[8px]"
    >
      <div className="mt-0.5 shrink-0">
        {isSuccess ? (
          <CheckCircle2 className="h-4 w-4 text-agent" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] text-meta truncate">
          {notification.projectName}
        </p>
        <p className="text-[13px] leading-snug">{notification.title}</p>
        {/* The failure message, not just the title: the bell is the
            cross-project "what just went wrong" surface, so a failed
            session's reason is shown right here. Clamped for layout; the
            full text is on hover (title) and one click away in the session
            view (targetUrl). */}
        {notification.status === "failed" && notification.message && (
          <p
            title={notification.message}
            className="mt-1 max-w-full overflow-hidden text-ellipsis whitespace-pre-wrap break-words rounded-[6px] bg-band px-2 py-1 font-mono text-[11px] leading-snug text-destructive/90 line-clamp-4"
          >
            {notification.message}
          </p>
        )}
        <p className="text-[11px] font-mono text-meta mt-0.5">
          {timeAgo(notification.createdAt)}
        </p>
      </div>
    </button>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { notifications, unreadCount, markAsRead } = useNotifications();

  function handleOpenChange(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen && unreadCount > 0) {
      markAsRead();
    }
  }

  function handleNavigate(url: string) {
    setOpen(false);
    router.push(url);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex items-center justify-center w-[34px] h-[34px] rounded-[9px] hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors"
          title="Notifications"
        >
          <Bell className="w-[17px] h-[17px]" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-primary-foreground bg-primary rounded-full">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="w-96 p-0"
        sideOffset={8}
      >
        <div className="px-3 py-2 border-b">
          <h3 className="text-sm font-semibold">Notifications</h3>
        </div>
        {notifications.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            No notifications yet
          </div>
        ) : (
          <ScrollArea className="max-h-[400px]">
            <div className="p-1">
              {notifications.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
