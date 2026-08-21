"use client";

import { useMemo, useState } from "react";
import { ImageLightbox, type LightboxImage } from "@/components/shared/ImageLightbox";
import { parseTicketImages } from "@/lib/uploads/ticket-images";
import { cn } from "@/lib/utils";

interface TicketImagesSectionProps {
  projectId: string;
  /** Raw `epics.images` JSON, exactly as the API hands it over. */
  images: string | null | undefined;
  /** The panel's section-label class, so this block matches its siblings. */
  labelClassName?: string;
  className?: string;
}

/**
 * The screenshots attached when a bug was reported, as clickable thumbnails
 * that open full size.
 *
 * Renders nothing at all when the ticket carries no usable image — which is
 * every ticket created before this feature, every feature epic, and any row
 * whose `images` column holds something the normaliser refuses. Those tickets
 * look exactly as they did.
 */
export function TicketImagesSection({
  projectId,
  images,
  labelClassName,
  className,
}: TicketImagesSectionProps) {
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const attachments = useMemo(
    () => parseTicketImages(images, projectId),
    [images, projectId]
  );

  if (attachments.length === 0) return null;

  return (
    <div
      className={cn("flex flex-col gap-[10px]", className)}
      data-testid="ticket-images"
    >
      <span className={labelClassName}>
        {attachments.length > 1 ? "Screenshots" : "Screenshot"}
      </span>

      <div className="flex flex-wrap gap-2">
        {attachments.map((image, index) => (
          <button
            // Two identical paths are a caller's business, not this list's —
            // the index keeps their keys apart without dropping either.
            key={`${image.path}-${index}`}
            type="button"
            onClick={() => setLightboxImage({ url: image.url, alt: image.fileName })}
            className="overflow-hidden rounded-[8px] border border-border transition-colors hover:border-primary"
            aria-label={`Open ${image.fileName}`}
          >
            <img
              src={image.url}
              alt={image.fileName}
              loading="lazy"
              className="h-[92px] w-[92px] bg-muted object-cover"
            />
          </button>
        ))}
      </div>

      <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
}
