import { NextResponse } from "next/server";
import { execSync } from "child_process";

function isOnPath(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isCodexLoggedIn(): boolean {
  try {
    // codex login status writes to stderr, not stdout
    const output = execSync("codex login status 2>&1", {
      encoding: "utf-8",
      timeout: 5000,
    });
    return /logged in/i.test(output);
  } catch {
    return false;
  }
}

export async function GET() {
  const codexOnPath = isOnPath("codex");

  return NextResponse.json({
    data: {
      "claude-code": isOnPath("claude"),
      codex: codexOnPath && isCodexLoggedIn(),
      codexInstalled: codexOnPath,
      "gemini-cli": isOnPath("gemini"),
    },
  });
}
