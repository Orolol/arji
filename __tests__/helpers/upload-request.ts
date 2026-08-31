/**
 * What the platform actually hands `POST /api/projects/:id/chat/upload`.
 *
 * `proxy.ts` matches `/api/:path*`, so Next buffers every API request
 * body up to `experimental.proxyClientMaxBodySize` and gives the route only
 * what fitted. A body over that cap arrives truncated and `request.formData()`
 * rejects with a `TypeError`, which is a different failure — and a different
 * answer — from the route's own size guard refusing a file it could read.
 *
 * Tests that care about the size boundary have to tell those two apart, so
 * they drive the route through this simulation rather than through a request
 * that always parses. The cap is read from `next.config.ts` so the simulation
 * tracks the real configuration instead of a copy of it.
 *
 * This file lives in `__tests__/helpers/`: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */

import type { NextRequest } from "next/server";
import nextConfig from "@/next.config";

/** Next's documented default when `proxyClientMaxBodySize` is not configured. */
export const NEXT_DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

function parseSizeLimit(value: string): number {
  const match = /^\s*([\d.]+)\s*(b|kb|mb|gb)\s*$/i.exec(value);
  if (!match) throw new Error(`Unparseable size limit: ${value}`);
  return Number(match[1]) * SIZE_UNITS[match[2]!.toLowerCase()]!;
}

/** What the platform will actually let through to the route handler. */
export const PLATFORM_MAX_BODY_BYTES = (() => {
  const configured = nextConfig.experimental?.proxyClientMaxBodySize;
  if (typeof configured === "number") return configured;
  if (typeof configured === "string") return parseSizeLimit(configured);
  return NEXT_DEFAULT_MAX_BODY_BYTES;
})();

export const MULTIPART_BOUNDARY = "----ArijFormBoundaryEXAMPLE0123456789";

/**
 * Bytes the multipart wrapper adds around the file's own bytes. Measured from
 * the real headers rather than guessed, because the whole defect these helpers
 * exist for is that this overhead is what pushed an at-the-limit file past the
 * platform cap.
 */
export function multipartEnvelopeBytes(fileName: string, mimeType: string): number {
  const encoder = new TextEncoder();
  const head =
    `--${MULTIPART_BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${MULTIPART_BOUNDARY}--\r\n`;
  return encoder.encode(head).length + encoder.encode(tail).length;
}

/** Size of the whole request body a browser would send for this one file. */
export function multipartBodyBytes(file: { name: string; type: string; size: number }): number {
  return file.size + multipartEnvelopeBytes(file.name, file.type);
}

/**
 * jsdom's `File` has no `arrayBuffer()`, and the route needs one — so the
 * uploaded file is described directly rather than built through jsdom.
 */
export function fileOfSize(name: string, type: string, size: number): File {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as File;
}

export interface PlatformRequest {
  request: NextRequest;
  /** Whether the body fitted under the cap, i.e. whether the route sees the file. */
  delivered: boolean;
  bodyBytes: number;
}

/**
 * A request as the platform delivers it: intact when the whole multipart body
 * fits under the cap, truncated — so `formData()` rejects the way it does in
 * production — when it does not. `content-length` describes what the client
 * tried to send either way.
 */
export function platformUpload(file: File): PlatformRequest {
  const bodyBytes = multipartBodyBytes(file);
  const headers = new Headers({
    "content-length": String(bodyBytes),
    "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
  });
  const delivered = bodyBytes <= PLATFORM_MAX_BODY_BYTES;

  const request = delivered
    ? ({
        headers,
        formData: async () => ({
          get: (name: string) => (name === "file" ? file : null),
        }),
      } as unknown as NextRequest)
    : ({
        headers,
        formData: async () => {
          throw new TypeError("Failed to parse body as FormData.");
        },
      } as unknown as NextRequest);

  return { request, delivered, bodyBytes };
}

/** The request alone, for tests that do not assert on delivery. */
export function platformRequest(file: File): NextRequest {
  return platformUpload(file).request;
}
