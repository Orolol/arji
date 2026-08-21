"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

export interface LightboxImage {
  url: string;
  alt: string;
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
        aria-label="Close image"
      >
        <X className="h-6 w-6" />
      </button>
      <img
        src={image.url}
        alt={image.alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
