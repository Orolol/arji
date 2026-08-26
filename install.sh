#!/usr/bin/env bash
#
# Arij installer — dependencies, agent CLIs, and the MCP tool channel.
#
# Three phases, each skippable:
#   1. the app        node version check, npm install, data dir
#   2. the CLIs       claude-code / codex / omp, offered one by one
#   3. the channel    registers Arij's MCP server in each CLI's own config
#
# Re-runnable. Every config write is a merge, never a clobber, and every file
# it touches is backed up next to itself first.
#
# Usage: ./install.sh [--yes] [--skip-app] [--skip-cli] [--skip-mcp] [--help]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_PATH="$REPO_ROOT/bin/arij-mcp.mjs"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=9
SERVER_NAME="arij"

ASSUME_YES=0
DO_APP=1
DO_CLI=1
DO_MCP=1

# ------------------------------------------------------------------ output --

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$BOLD" "$RESET" "$BOLD" "$1" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
info() { printf '  %s·%s %s\n' "$DIM" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
  exit 0
}

# Yes/no prompt.
#
# --yes accepts everything. With no tty and no --yes the answer is NO, whatever
# the default: a script being piped somewhere should report what it would have
# installed, not install it unasked.
confirm() {
  local prompt="$1" default="${2:-y}" reply
  [ "$ASSUME_YES" = "1" ] && return 0
  if [ ! -t 0 ]; then
    info "not a terminal and no --yes — skipping"
    return 1
  fi
  local hint="[Y/n]"
  [ "$default" = "y" ] || hint="[y/N]"
  printf '  %s %s ' "$prompt" "$hint"
  read -r reply || reply=""
  reply="${reply:-$default}"
  case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --skip-app) DO_APP=0 ;;
    --skip-cli) DO_CLI=0 ;;
    --skip-mcp) DO_MCP=0 ;;
    --help|-h) usage ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# Timestamped sibling copy, so a bad merge is always recoverable.
#
# Logs to stderr on purpose: callers run the merge helpers through command
# substitution to read their result, and a progress line on stdout would be
# captured as part of that result.
backup_file() {
  local target="$1"
  [ -f "$target" ] || return 0
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "$target" "$target.arij-backup-$stamp"
  info "backed up $(basename "$target") → $(basename "$target").arij-backup-$stamp" >&2
}

# ------------------------------------------------------------- 1. the app --

install_app() {
  step "Arij"

  have node || die "node not found. Install Node.js >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR and re-run."

  local node_version major minor
  node_version="$(node -p 'process.versions.node')"
  major="${node_version%%.*}"
  minor="$(printf '%s' "$node_version" | cut -d. -f2)"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ] ||
     { [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; }; then
    die "node $node_version is too old — Arij needs >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR."
  fi
  ok "node $node_version"

  have git || die "git not found. Arij drives real repositories and cannot run without it."
  ok "git $(git --version | awk '{print $3}')"

  info "installing dependencies (npm install)…"
  (cd "$REPO_ROOT" && npm install --silent) || die "npm install failed."
  ok "dependencies installed"

  # The SQLite file is created on first run; the directory has to exist first.
  mkdir -p "$REPO_ROOT/data"
  ok "data directory ready"
}

# ------------------------------------------------------------- 2. the CLIs --

# offer_cli <name> <binary> <install command> <what it is>
#
# Passed as four arguments rather than packed into one delimited string: omp's
# install command is a `curl … | sh` pipeline, and any single-character
# delimiter cheap enough to read is a character some install command will
# eventually contain.
offer_cli() {
  local name="$1" bin="$2" cmd="$3" desc="$4"

  printf '\n'
  if have "$bin"; then
    # First dotted-number in the output, not the first line: several of these
    # CLIs print a warning or a banner before their version.
    local version
    version="$("$bin" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    ok "$name already installed${version:+ ($version)}"
    return 0
  fi

  printf '  %s%s%s — %s\n' "$BOLD" "$name" "$RESET" "$desc"
  printf '  %s%s%s\n' "$DIM" "$cmd" "$RESET"
  if ! confirm "install $name?" "y"; then
    info "skipped $name"
    return 0
  fi
  if eval "$cmd"; then
    ok "$name installed"
  else
    warn "$name install failed — continuing without it"
  fi
}

install_clis() {
  step "Agent CLIs"
  info "Arij needs at least one. Skip anything you do not want."

  offer_cli "Claude Code" claude \
    "npm install -g @anthropic-ai/claude-code" \
    "Anthropic's agent CLI. Arij's default, and the only provider whose MCP channel needs no special flags."

  offer_cli "Codex" codex \
    "npm install -g @openai/codex" \
    "OpenAI's agent CLI. Arij runs it with approvals bypassed — its exec mode refuses every MCP tool call otherwise."

  offer_cli "omp" omp \
    "curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh" \
    "Oh My Pi. Reads MCP servers from mcp.json and expands \${VAR} at load time."

  if ! have agy; then
    printf '\n'
    info "Antigravity (agy) has no scripted install — get it from its own installer,"
    info "then re-run ./install.sh --skip-app --skip-cli to register the MCP entry."
  fi
}

# ---------------------------------------------------------- 3. the channel --

# Merges one server entry into a JSON config's mcpServers map, creating the
# file if absent and leaving every other key untouched. Node does the parsing
# because it is already a hard dependency and jq is not.
merge_json_mcp() {
  local config_path="$1" entry_json="$2"
  mkdir -p "$(dirname "$config_path")"
  backup_file "$config_path"
  SERVER_NAME="$SERVER_NAME" CONFIG_PATH="$config_path" ENTRY_JSON="$entry_json" node <<'NODE'
const fs = require("node:fs");
const path = process.env.CONFIG_PATH;
const name = process.env.SERVER_NAME;

let config = {};
if (fs.existsSync(path)) {
  const raw = fs.readFileSync(path, "utf8").trim();
  if (raw) {
    try {
      config = JSON.parse(raw);
    } catch {
      // A config we cannot parse is a config we must not overwrite.
      console.error(`  ! ${path} is not valid JSON — left untouched`);
      process.exit(3);
    }
  }
}

config.mcpServers = config.mcpServers ?? {};
const existed = Boolean(config.mcpServers[name]);
config.mcpServers[name] = JSON.parse(process.env.ENTRY_JSON);
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(existed ? "updated" : "added");
NODE
}

# The stdio entry every JSON-configured CLI gets.
#
# The token is a ${VAR} reference, not a literal: Arij mints a fresh bearer per
# session and revokes it when the process exits (lib/mcp/token-store.ts), so
# there is no long-lived value to write down. The entry activates when Arij
# spawns the CLI with ARIJ_MCP_TOKEN in its environment; a CLI launched by hand
# without one gets a server that exits immediately with a clear message on
# stderr, which every host isolates per-server.
#
# That last part needs the shim's placeholder guard to be true: hosts do NOT
# agree on what an unresolved ${VAR} becomes. omp (measured on 18.0.5) hands
# the literal string "${ARIJ_MCP_TOKEN}" straight through, which is non-empty,
# so bin/arij-mcp.mjs treats any value still containing ${...} as no value at
# all. Without that guard the server starts and 401s every call instead of
# bowing out.
#
# ARIJ_MCP_TOOLSET rides the same seam: agent sessions leave it unset (the
# default expands to "agent"), CLI chat turns set it to "chat" so the shim
# serves the board toolset. Only omp actually needs the passthrough — claude
# gets a per-session --mcp-config carrying the real value — but the entry is
# shared and the default keeps it inert everywhere else.
arij_entry_json() {
  local node_bin
  node_bin="$(command -v node)"
  cat <<JSON
{
  "type": "stdio",
  "command": "$node_bin",
  "args": ["$SHIM_PATH"],
  "env": {
    "ARIJ_BASE_URL": "\${ARIJ_BASE_URL:-http://localhost:3000}",
    "ARIJ_MCP_TOKEN": "\${ARIJ_MCP_TOKEN}",
    "ARIJ_MCP_TOOLSET": "\${ARIJ_MCP_TOOLSET:-agent}"
  }
}
JSON
}

configure_omp() {
  have omp || { info "omp not installed — skipping its MCP config"; return 0; }

  # `omp config path` prints the active agent dir; fall back to the documented
  # default when an older build does not support it.
  local agent_dir
  agent_dir="$(omp config path 2>/dev/null | tail -1 | tr -d '[:space:]')"
  [ -n "$agent_dir" ] && [ -d "$agent_dir" ] || agent_dir="$HOME/.omp/agent"

  local config_path="$agent_dir/mcp.json"
  local result
  if result="$(merge_json_mcp "$config_path" "$(arij_entry_json)")"; then
    ok "omp: $result $SERVER_NAME in $config_path"
  else
    warn "omp: could not write $config_path"
  fi
}

configure_claude() {
  have claude || { info "claude not installed — skipping its MCP config"; return 0; }

  # Project-scoped .mcp.json, so the entry follows the repo rather than the
  # machine. Arij's own sessions do not read this — they get --mcp-config with
  # a per-session file, plus --strict-mcp-config which ignores everything else.
  # This is for running `claude` by hand inside the repo.
  local config_path="$REPO_ROOT/.mcp.json"
  local result
  if result="$(merge_json_mcp "$config_path" "$(arij_entry_json)")"; then
    ok "claude: $result $SERVER_NAME in .mcp.json"
  else
    warn "claude: could not write $config_path"
  fi
}

configure_codex() {
  have codex || { info "codex not installed — skipping its MCP config"; return 0; }

  local config_path="$HOME/.codex/config.toml"
  mkdir -p "$(dirname "$config_path")"

  if [ -f "$config_path" ] && grep -q "^\[mcp_servers\.$SERVER_NAME\]" "$config_path"; then
    ok "codex: $SERVER_NAME already in config.toml"
    return 0
  fi

  backup_file "$config_path"
  # Appended rather than merged: this is the one config that is TOML, and a
  # hand-rolled TOML rewriter would be a worse risk than an append. No env
  # table — codex does not document ${VAR} expansion, and its MCP servers
  # inherit the parent environment, which is where Arij puts the token.
  {
    printf '\n[mcp_servers.%s]\n' "$SERVER_NAME"
    printf 'command = %s\n' "\"$(command -v node)\""
    printf 'args = ["%s"]\n' "$SHIM_PATH"
  } >> "$config_path"
  ok "codex: added $SERVER_NAME to config.toml"
}

configure_agy() {
  have agy || { info "agy not installed — skipping its MCP config"; return 0; }

  # agy's config is user-global and owned by `agy mcp` (writing the JSON by
  # hand would race its own migrations between config paths). No env in the
  # entry: measured on 1.1.21, agy spawns MCP servers from the CLI process
  # itself and they inherit its environment, which is where Arij puts the
  # per-session ARIJ_* values (AgyProvider.buildEnv). `add` also updates an
  # existing entry, so this is idempotent.
  if agy mcp add "$SERVER_NAME" "$(command -v node)" "$SHIM_PATH" >/dev/null 2>&1; then
    ok "agy: registered $SERVER_NAME via \`agy mcp add\`"
  else
    warn "agy: \`agy mcp add\` failed — register the shim manually"
  fi
}

configure_mcp() {
  step "MCP tool channel"

  [ -f "$SHIM_PATH" ] || die "MCP shim not found at $SHIM_PATH — is this an Arij checkout?"

  info "registering the Arij server so each CLI can reach the board"
  configure_claude
  configure_codex
  configure_omp
  configure_agy

  printf '\n'
  warn "These entries carry \${ARIJ_MCP_TOKEN}, not a token."
  info "Arij mints one per session and revokes it at exit, so the channel comes"
  info "alive when Arij spawns the CLI. Launched by hand with no token, the"
  info "server exits immediately and the CLI carries on without it."
}

# -------------------------------------------------------------------- main --

printf '%sArij installer%s\n' "$BOLD" "$RESET"
printf '%s%s%s\n' "$DIM" "$REPO_ROOT" "$RESET"

[ "$DO_APP" = "1" ] && install_app
[ "$DO_CLI" = "1" ] && install_clis
[ "$DO_MCP" = "1" ] && configure_mcp

step "Done"
printf '  Start Arij:      %snpm run dev%s\n' "$BOLD" "$RESET"
printf '  Then open:       %shttp://localhost:3000%s\n' "$BOLD" "$RESET"
printf '  Provider matrix: %sdocs/architecture/mcp-provider-matrix.md%s\n\n' "$DIM" "$RESET"
