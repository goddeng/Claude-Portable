#!/usr/bin/env bash
# =============================================================================
# Claude Code Portable Launcher - macOS (v1.0.7+)
#
# Persistence model: plugins, history, projects, sessions all live under
# data/.claude on the USB drive. Only .credentials.json is transient — wiped
# on every start and on every clean exit (incl. Ctrl+C).
# =============================================================================
set -euo pipefail

PORTABLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${PORTABLE_ROOT}/data"
NODE_DIR="${PORTABLE_ROOT}/runtime/node"
CLAUDE_DIR="${PORTABLE_ROOT}/runtime/claude-code"
SS_DIR="${PORTABLE_ROOT}/runtime/ss"
SRC_DIR="${PORTABLE_ROOT}/src"

export PATH="${NODE_DIR}/bin:${PATH}"
export CLAUDE_PORTABLE_DATA="${DATA_DIR}"
export CLAUDE_CONFIG_DIR="${DATA_DIR}/.claude"
mkdir -p "${CLAUDE_CONFIG_DIR}"

# Remove Gatekeeper quarantine on the bundle so bundled binaries (node, sslocal,
# claude) can execute without "app is damaged" prompts. Silent if already clean.
if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "${PORTABLE_ROOT}" 2>/dev/null || true
fi

CREDS_FILE="${CLAUDE_CONFIG_DIR}/.credentials.json"
SS_ARGS_FILE="${CLAUDE_CONFIG_DIR}/.ss_args"

rm -f "$CREDS_FILE" "$SS_ARGS_FILE"

SS_PID=""
HEARTBEAT_PID=""

cleanup() {
    [[ -n "$SS_PID" ]] && kill "$SS_PID" 2>/dev/null || true
    [[ -n "$HEARTBEAT_PID" ]] && kill "$HEARTBEAT_PID" 2>/dev/null || true
    rm -f "$CREDS_FILE" "$SS_ARGS_FILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- License kill-switch (set by heartbeat on explicit revoke/expire) ---
if [[ -f "${DATA_DIR}/.license_expired" ]]; then
    echo ""
    echo "  License has been revoked or expired. Please contact administrator."
    rm -f "${DATA_DIR}/.license_expired"
    exit 2
fi

# --- License check + credential sync ---
"${NODE_DIR}/bin/node" "${SRC_DIR}/license-client.js"
if [[ $? -ne 0 ]]; then
    echo ""
    echo "  License verification failed. Please contact administrator."
    exit 1
fi

# --- Start Shadowsocks proxy ---
if [[ -x "${SS_DIR}/sslocal" && -f "$SS_ARGS_FILE" ]]; then
    SS_ARGS=$(cat "$SS_ARGS_FILE")
    rm -f "$SS_ARGS_FILE"
    ${SS_DIR}/sslocal ${SS_ARGS} &>/dev/null &
    SS_PID=$!
    sleep 1
    export HTTP_PROXY="http://127.0.0.1:51080"
    export HTTPS_PROXY="http://127.0.0.1:51080"
fi

# --- Start heartbeat in background ---
"${NODE_DIR}/bin/node" "${SRC_DIR}/heartbeat.js" &>/dev/null &
HEARTBEAT_PID=$!

# --- Launch Claude Code (native binary, v2.x) ---
CLAUDE_BIN="${CLAUDE_DIR}/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
if [[ ! -x "$CLAUDE_BIN" ]]; then
    echo "Error: Claude Code not found. Package may be corrupted."
    exit 1
fi

"${CLAUDE_BIN}" --system-prompt-file "${SRC_DIR}/portable-claude.md" "$@"
