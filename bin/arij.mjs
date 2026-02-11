#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
const command = args[0];

function getNextBin() {
  return resolve(projectRoot, "node_modules", ".bin", "next");
}

function printHelp() {
  console.log(`
arij - AI-first project orchestrator

Usage:
  arij              Start the production server
  arij dev          Start the development server
  arij build        Build for production
  arij --help       Show this help message
  arij --version    Show version
`);
}

function printVersion() {
  const pkg = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf-8")
  );
  console.log(pkg.version);
}

try {
  if (command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    printVersion();
    process.exit(0);
  }

  if (command === "dev") {
    execFileSync(getNextBin(), ["dev"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } else if (command === "build") {
    execFileSync(getNextBin(), ["build"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } else if (!command || command === "start") {
    execFileSync(getNextBin(), ["start"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
} catch (error) {
  if (error.status != null) {
    process.exit(error.status);
  }
  console.error(error.message);
  process.exit(1);
}
