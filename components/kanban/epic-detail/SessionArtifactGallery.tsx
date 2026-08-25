"use client";

import { useState } from "react";
import {
  ImageLightbox,
  type LightboxImage,
} from "@/components/shared/ImageLightbox";
import {
  sessionArtifactUrl,
  type SessionArtifactSummary,
} from "@/lib/agent-sessions/artifact-view";
import { cn } from "@/lib/utils";

interface SessionArtifactGalleryProps {
  projectId: string;
  artifacts: SessionArtifactSummary[];
  className?: string;
}

/** High-bandwidth visual proof shown immediately above the review diff. */
export function SessionArtifactGallery({
  projectId,
  artifacts,
  className,
}: SessionArtifactGalleryProps) {
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);

  if (artifacts.length === 0) return null;

  return (
    <section
      className={cn("flex flex-col gap-[10px]", className)}
      data-testid="session-artifact-gallery"
    >
      <div>
        <h3 className="text-[12px] uppercase tracking-[.08em] text-meta">
          Visual proof
        </h3>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Screenshots captured by build agents for this ticket.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {artifacts.map((artifact) => {
          const url = sessionArtifactUrl(projectId, artifact.id);
          return (
            <figure
              key={artifact.id}
              className="overflow-hidden rounded-[10px] border border-border bg-band"
            >
              <button
                type="button"
                onClick={() =>
                  setLightboxImage({
                    url,
                    alt: artifact.caption,
                    caption: artifact.caption,
                  })
                }
                className="block w-full overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={`Open visual proof: ${artifact.caption}`}
              >
                {/* Project-scoped local API image; keep the browser request in
                    project scope instead of proxying through Next Image. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={artifact.caption}
                  loading="lazy"
                  className="aspect-video w-full bg-muted object-cover transition-transform hover:scale-[1.01]"
                />
              </button>
              <figcaption className="px-3 py-2 text-[12.5px] leading-[1.45] text-muted-foreground">
                {artifact.caption}
              </figcaption>
            </figure>
          );
        })}
      </div>

      <ImageLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </section>
  );
}
