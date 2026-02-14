import { NextRequest, NextResponse } from "next/server";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function extractHost(headerValue: string): string {
  // Handle IPv6 like [::1]:3000
  if (headerValue.startsWith("[")) {
    const end = headerValue.indexOf("]");
    return end >= 0 ? headerValue.slice(0, end + 1) : headerValue;
  }
  // Handle hostname:port
  return headerValue.split(":")[0];
}

function isLocalHost(headerValue: string | null): boolean {
  if (!headerValue) return false;
  return LOCAL_HOSTS.includes(extractHost(headerValue));
}

function getAllowedOrigins(): string[] {
  return (
    process.env.ALLOWED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const allowedOrigins = getAllowedOrigins();

  // Check host header
  if (!isLocalHost(host)) {
    // If host is not local, check if origin is in the allowed list
    if (origin && allowedOrigins.includes(origin)) {
      // Allowed via ALLOWED_ORIGINS
    } else {
      return NextResponse.json(
        { error: "Forbidden: non-local request" },
        { status: 403 }
      );
    }
  }

  // If origin header is present, verify it's also local or allowed
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      if (!LOCAL_HOSTS.includes(originHost) && !allowedOrigins.includes(origin)) {
        return NextResponse.json(
          { error: "Forbidden: non-local origin" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Forbidden: invalid origin" },
        { status: 403 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
