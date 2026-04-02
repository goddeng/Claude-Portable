#!/usr/bin/env bash
# =============================================================================
# Claude Code Portable Launcher - Linux
# =============================================================================
set -euo pipefail

PORTABLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${PORTABLE_ROOT}/data"
NODE_DIR="${PORTABLE_ROOT}/runtime/node"
CLAUDE_DIR="${PORTABLE_ROOT}/runtime/claude-code"
SS_DIR="${PORTABLE_ROOT}/runtime/ss"
SRC_DIR="${PORTABLE_ROOT}/src"

export PATH="${NODE_DIR}/bin:${PATH}"
export CLAUDE_CONFIG_DIR="${DATA_DIR}/.claude"
export CLAUDE_PORTABLE_DATA="${DATA_DIR}"
mkdir -p "${CLAUDE_CONFIG_DIR}"

# --- License check + credential sync ---
"${NODE_DIR}/bin/node" "${SRC_DIR}/license-client.js"
if [[ $? -ne 0 ]]; then
    echo ""
    echo "  License verification failed. Please contact administrator."
    exit 1
fi

# --- Start Shadowsocks proxy (no config file on disk) ---
SS_PID=""
HEARTBEAT_PID=""
SS_ARGS_FILE="${DATA_DIR}/.ss_args"
if [[ -x "${SS_DIR}/sslocal" && -f "$SS_ARGS_FILE" ]]; then
    SS_ARGS=$(cat "$SS_ARGS_FILE")
    rm -f "$SS_ARGS_FILE" "${SS_DIR}/ss-config.json"
    ${SS_DIR}/sslocal ${SS_ARGS} &>/dev/null &
    SS_PID=$!
    sleep 1
    export HTTP_PROXY="http://127.0.0.1:51080"
    export HTTPS_PROXY="http://127.0.0.1:51080"
fi

# --- Start heartbeat in background ---
"${NODE_DIR}/bin/node" "${SRC_DIR}/heartbeat.js" &>/dev/null &
HEARTBEAT_PID=$!

# Cleanup on exit
cleanup() {
    [[ -n "$SS_PID" ]] && kill "$SS_PID" 2>/dev/null || true
    [[ -n "$HEARTBEAT_PID" ]] && kill "$HEARTBEAT_PID" 2>/dev/null || true
}
trap cleanup EXIT

# --- Launch Claude Code ---
CLAUDE_CLI="${CLAUDE_DIR}/node_modules/@anthropic-ai/claude-code/cli.js"
if [[ ! -f "$CLAUDE_CLI" ]]; then
    echo "Error: Claude Code not found. Package may be corrupted."
    exit 1
fi

"${NODE_DIR}/bin/node" "${CLAUDE_CLI}" --system-prompt-file "${SRC_DIR}/portable-claude.md" "$@"
