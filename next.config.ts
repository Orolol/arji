import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "pdfjs-dist"],
  experimental: {
    /**
     * `middleware.ts` matches `/api/:path*`, so Next buffers every API request
     * body up to this cap and hands the route only what fitted. The default is
     * 10485760 — byte for byte `MAX_IMAGE_UPLOAD_BYTES` in
     * `lib/uploads/image-attachments.ts`. A file *at* the app's own limit
     * therefore overflowed the platform's as soon as the multipart envelope was
     * added: the body reached the route truncated, `request.formData()` threw,
     * and the size guard the limit exists to explain could never run.
     *
     * 1MB of headroom separates the two, so an upload is refused by the app's
     * message rather than by the platform's truncation. Raising this rather
     * than lowering the app limit keeps the ~9MB uploads that work today
     * working. Anything past this cap still gets the route's 413.
     */
    proxyClientMaxBodySize: 11 * 1024 * 1024,
  },
};

export default nextConfig;
