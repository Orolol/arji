import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "pdfjs-dist"],

  /**
   * The loopback hosts `middleware.ts` already accepts for `/api/*`.
   *
   * Next 16.3 blocks cross-site requests to `/_next/*` dev resources against a
   * default allowlist of `['**.localhost', 'localhost']` plus whatever
   * `--hostname` bound. Chrome labels the chunk `<script>` loads of a page
   * served from an IP literal `Sec-Fetch-Site: cross-site`, so on
   * `http://127.0.0.1:3000` every `/_next/static/chunks/*.js` came back 403
   * while `http://localhost:3000` worked.
   *
   * Nothing announces that. The API answers — middleware trusts `127.0.0.1` —
   * and the server markup renders, so the page looks like it loaded; hydration
   * just never runs and the board sits inert. Measured on 16.3.3: with
   * `Sec-Fetch-Mode: no-cors` + `Sec-Fetch-Site: cross-site`, a `127.0.0.1`
   * referer got 403 and a `localhost` referer got 200.
   *
   * `localhost` is already in Next's default allowlist; these two are the
   * spellings that were missing. The list is deliberately the loopback set and
   * nothing wider — this closes the gap between the two layers rather than
   * turning the protection off. Development only: the enforcement does not
   * exist in a production server, which serves `127.0.0.1` fine.
   */
  allowedDevOrigins: ["127.0.0.1", "[::1]"],
};

export default nextConfig;
