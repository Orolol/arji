"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "next-intl";

interface SpecPreviewProps {
  markdown: string;
}

/**
 * Rendered markdown for the spec and the memory preview.
 *
 * Typography follows frame 8b's editor card: Bricolage Grotesque 700 for the
 * headings (h1 21 / h2 15 / h3 13.5), Instrument Sans 13.5/1.6 in `--foreground`
 * for prose, Space Mono on `--muted` for code. Structure and the plugin set are
 * unchanged.
 *
 * THIS RENDERER IS SHARED by the spec preview and the memory preview, on two
 * different strata grounds, which is why nothing in here is allowed to pick a
 * stratum colour:
 *
 * - rules are 1.5px, the house border weight (2px is reserved for selection);
 * - the `hr` names its width explicitly — Tailwind's preflight resets every
 *   element to `border: 0 solid`, so the bare `border-border-soft` it used to
 *   carry drew NOTHING at all;
 * - a link is INK plus an underline, never `--primary`. The action green is
 *   the filled-button colour, and "text is ink or dim, never coloured except
 *   a stratum deep" — a shared renderer has no stratum to borrow;
 * - the inline code chip is a pill. 4px is not on the radius scale (bands
 *   14-16, cards 10-12, fields 10, pills 9999, overlay 20).
 */

export function SpecPreview({ markdown }: SpecPreviewProps) {
  const t = useTranslations("Spec");

  if (!markdown) {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        {t("preview.empty")}
      </p>
    );
  }

  return (
    <div className="font-sans text-[13.5px] leading-[1.6] text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-[10px] mt-[22px] font-display text-[21px] font-bold tracking-[-0.01em] first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-[8px] mt-[20px] font-display text-[15px] font-bold first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-[8px] mt-[18px] font-display text-[13.5px] font-bold first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-[6px] mt-[16px] font-display text-[12.5px] font-bold first:mt-0">
              {children}
            </h4>
          ),
          p: ({ children }) => <p className="mb-[12px] last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-[12px] list-disc pl-[20px] leading-[1.8]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-[12px] list-decimal pl-[20px] leading-[1.8]">
              {children}
            </ol>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-foreground underline underline-offset-2">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-[12px] border-l-[1.5px] border-border pl-[14px] text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-[22px] border-t-[1.5px] border-border-soft" />,
          code: ({ className, children }) => {
            const isBlock = className?.includes("language-");
            if (isBlock) {
              return (
                <code className="font-mono text-[12.5px]">{children}</code>
              );
            }
            return (
              <code className="rounded-full bg-muted px-[6px] py-[2px] font-mono text-[12.5px]">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-[12px] overflow-x-auto rounded-[10px] bg-muted p-[14px] leading-[1.6]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-[12px] overflow-x-auto">
              <table className="w-full text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b-[1.5px] border-border px-[10px] py-[7px] text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b-[1.5px] border-border-soft px-[10px] py-[7px] align-top">
              {children}
            </td>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
