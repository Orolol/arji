import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "pdfjs-dist"],
  /**
   * `next dev` answers 403 to any `/_next/*` request whose `Origin` it does
   * not recognise, and its built-in list covers `localhost` but not the
   * loopback address. A browser pointed at `http://127.0.0.1:<port>` — which
   * is what the Playwright suite uses, and what the dev server itself prints
   * as its network address — therefore loads the document and then fails
   * every chunk, leaving a hydrated-looking shell with no data in it.
   *
   * The entries are exactly `middleware.ts`'s `LOCAL_HOSTS` — the same
   * machine, named three ways — and this list is read by the dev server
   * only; it grants nothing in production.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost", "[::1]"],
};

export default nextConfig;
