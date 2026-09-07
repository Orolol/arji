"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

export interface LightboxImage {
  url: string;
  alt: string;
  /** Optional prose shown below the enlarged image. */
  caption?: string;
}

interface ImageLightboxProps {
  /** `null` closes the lightbox — the caller owns the open state. */
  image: LightboxImage | null;
  onClose: () => void;
}

/**
 * Full-screen view of a single image, dismissed by Escape, by the ✕, or by
 * clicking outside the image. Extracted from the chat transcript so the ticket
 * panel's screenshots open exactly the same way rather than growing a second
 * near-identical overlay.
 */
export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  const t = useTranslations("Shared");
  useEffect(() => {
    if (!image) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
      data-testid="image-lightbox"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 transition-colors hover:text-white"
        type="button"
        aria-label={t("imageLightbox.close")}
      >
        <X className="h-6 w-6" />
      </button>
      <figure
        className="flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Callers use local project-scoped/dynamic image routes. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.url}
          alt={image.alt}
          className="min-h-0 max-h-[86vh] max-w-[90vw] rounded-lg object-contain"
        />
        {image.caption && (
          <figcaption className="max-w-[80vw] text-center text-[13px] text-white/85">
            {image.caption}
          </figcaption>
        )}
      </figure>
    </div>
  );
}
