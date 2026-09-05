"use client";

/**
 * The screenshots a bug report carried, as thumbnails that open full size.
 *
 * Frame 6a draws no slot for them, and none is invented: they belong to the
 * description — they ARE the description of a bug most of the time — so they
 * sit inside the white description card, under the prose, above the meta line.
 * No band, no header of their own, just a kicker and a row of cards.
 *
 * `BugCreateDialog` has never stopped writing these into `epics.images`; the
 * Piscine redesign dropped the only reader, which made every attached
 * screenshot unviewable. This is that reader.
 *
 * Renders nothing at all when the ticket carries no usable image — which is
 * every feature epic, every ticket predating the feature, and any row whose
 * `images` column holds something `parseTicketImages` refuses.
 */

import * as React from "react";

import { FieldKicker, SurfaceCard } from "@/components/piscine";
import {
  ImageLightbox,
  type LightboxImage,
} from "@/components/shared/ImageLightbox";
import type { TicketImage } from "@/lib/uploads/ticket-images";

export interface TicketScreenshotsProps {
  /** Already normalised by `parseTicketImages` — this component never parses. */
  images: TicketImage[];
}

export function TicketScreenshots({ images }: TicketScreenshotsProps) {
  const [lightboxImage, setLightboxImage] = React.useState<LightboxImage | null>(
    null,
  );

  /**
   * ESCAPE PRECEDENCE. The lightbox opens on top of the ticket overlay, and
   * both close on Escape — one keypress would dismiss the enlarged image AND
   * the ticket behind it. `ImageLightbox` listens on `document` (bubble) and
   * the overlay on `window` (bubble, and it skips a key already handled), so
   * marking the event handled in the CAPTURE phase reaches the overlay and
   * not the lightbox: the image closes, the ticket stays.
   */
  React.useEffect(() => {
    if (!lightboxImage) return;
    const markHandled = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    window.addEventListener("keydown", markHandled, true);
    return () => window.removeEventListener("keydown", markHandled, true);
  }, [lightboxImage]);

  if (images.length === 0) return null;

  return (
    <div className="flex flex-col gap-[10px]" data-testid="ticket-images">
      <FieldKicker stratum="card">
        {images.length > 1 ? "Screenshots" : "Screenshot"}
      </FieldKicker>

      <div className="flex flex-wrap gap-2">
        {images.map((image, index) => (
          <button
            // Two identical paths are a caller's business, not this list's —
            // the index keeps their keys apart without dropping either.
            key={`${image.path}-${index}`}
            type="button"
            onClick={() =>
              setLightboxImage({ url: image.url, alt: image.fileName })
            }
            aria-label={`Open ${image.fileName}`}
            className="border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <SurfaceCard radius={10} interactive className="overflow-hidden">
              {/* Local, project-scoped upload route — not a remote asset. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.fileName}
                loading="lazy"
                className="block h-[92px] w-[92px] bg-field object-cover"
              />
            </SurfaceCard>
          </button>
        ))}
      </div>

      <ImageLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </div>
  );
}
