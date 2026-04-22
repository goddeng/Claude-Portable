#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# USB Claude - Portable Claude Code Builder
# Builds a portable Claude Code CLI package for the target platform
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="${SCRIPT_DIR}/dist"
BUILD_DIR="${SCRIPT_DIR}/build"

# Defaults
NODE_VERSION="22.14.0"
CLAUDE_CODE_VERSION="latest"
SS_VERSION="1.24.0"
GIT_VERSION="2.53.0.2"
CREDENTIALS_FILE="${SCRIPT_DIR}/configs/credentials.env"
SS_CONFIG_FILE="${SCRIPT_DIR}/configs/ss-config.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[BUILD]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# =============================================================================
# Detect or accept target platform
# =============================================================================
detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux*)  PLATFORM_OS="linux" ;;
        Darwin*) PLATFORM_OS="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM_OS="win" ;;
        *) error "Unsupported OS: $os" ;;
    esac

    case "$arch" in
        x86_64|amd64) PLATFORM_ARCH="x64" ;;
        aarch64|arm64) PLATFORM_ARCH="arm64" ;;
        *) error "Unsupported architecture: $arch" ;;
    esac
}

# =============================================================================
# Usage
# =============================================================================
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Options:
  --platform <os>       Target OS: linux, darwin, win (default: auto-detect)
  --arch <arch>         Target arch: x64, arm64 (default: auto-detect)
  --node-version <ver>  Node.js version (default: $NODE_VERSION)
  --claude-version <v>  Claude Code version (default: latest)
  --credentials <file>  Path to credentials.env (default: configs/credentials.env)
  --all                 Build for all platforms (linux-x64, darwin-x64, darwin-arm64, win-x64)
  --help                Show this help

Examples:
  $0                           # Build for current platform
  $0 --platform win --arch x64 # Build for Windows x64
  $0 --all                     # Build for all platforms
EOF
    exit 0
}

# =============================================================================
# Parse args
# =============================================================================
BUILD_ALL=false
detect_platform  # set defaults

while [[ $# -gt 0 ]]; do
    case "$1" in
        --platform)   PLATFORM_OS="$2"; shift 2 ;;
        --arch)       PLATFORM_ARCH="$2"; shift 2 ;;
        --node-version) NODE_VERSION="$2"; shift 2 ;;
        --claude-version) CLAUDE_CODE_VERSION="$2"; shift 2 ;;
        --credentials) CREDENTIALS_FILE="$2"; shift 2 ;;
        --all)        BUILD_ALL=true; shift ;;
        --help)       usage ;;
        *) error "Unknown option: $1" ;;
    esac
done

# =============================================================================
# Node.js download URL builder
# =============================================================================
node_download_url() {
    local os="$1" arch="$2"
    local ext="tar.gz"
    local node_os="$os"

    if [[ "$os" == "win" ]]; then
        ext="zip"
        node_os="win"
    fi

    echo "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${node_os}-${arch}.${ext}"
}

node_dirname() {
    local os="$1" arch="$2"
    echo "node-v${NODE_VERSION}-${os}-${arch}"
}

# =============================================================================
# Shadowsocks download URL builder
# =============================================================================
ss_download_url() {
    local os="$1" arch="$2"
    local base="https://github.com/shadowsocks/shadowsocks-rust/releases/download/v${SS_VERSION}"
    local target

    case "${os}-${arch}" in
        linux-x64)    target="x86_64-unknown-linux-gnu" ;;
        linux-arm64)  target="aarch64-unknown-linux-gnu" ;;
        darwin-x64)   target="x86_64-apple-darwin" ;;
        darwin-arm64) target="aarch64-apple-darwin" ;;
        win-x64)      target="x86_64-pc-windows-msvc" ;;
        *) error "No SS binary for ${os}-${arch}" ;;
    esac

    if [[ "$os" == "win" ]]; then
        echo "${base}/shadowsocks-v${SS_VERSION}.${target}.zip"
    else
        echo "${base}/shadowsocks-v${SS_VERSION}.${target}.tar.xz"
    fi
}

ss_binary_name() {
    local os="$1"
    if [[ "$os" == "win" ]]; then
        echo "sslocal.exe"
    else
        echo "sslocal"
    fi
}

# =============================================================================
# Build one platform
# =============================================================================
build_platform() {
    local os="$1" arch="$2"
    local target_name="claude-portable-${os}-${arch}"
    local target_dir="${DIST_DIR}/${target_name}"
    local node_url node_dir node_archive

    log "========================================="
    log "Building: ${target_name}"
    log "========================================="

    # Clean previous build
    rm -rf "${target_dir}"
    mkdir -p "${target_dir}/runtime" "${target_dir}/data"

    # --- Step 1: Download Node.js ---
    node_url="$(node_download_url "$os" "$arch")"
    node_dir="$(node_dirname "$os" "$arch")"

    if [[ "$os" == "win" ]]; then
        node_archive="${BUILD_DIR}/${node_dir}.zip"
    else
        node_archive="${BUILD_DIR}/${node_dir}.tar.gz"
    fi

    mkdir -p "${BUILD_DIR}"

    if [[ ! -f "$node_archive" ]]; then
        log "Downloading Node.js v${NODE_VERSION} for ${os}-${arch}..."
        curl -fSL --progress-bar -o "$node_archive" "$node_url" \
            || error "Failed to download Node.js from ${node_url}"
    else
        log "Using cached Node.js: ${node_archive}"
    fi

    # Extract
    log "Extracting Node.js..."
    if [[ "$os" == "win" ]]; then
        unzip -qo "$node_archive" -d "${BUILD_DIR}/"
    else
        tar -xzf "$node_archive" -C "${BUILD_DIR}/"
    fi

    # Move node runtime into target
    mv "${BUILD_DIR}/${node_dir}" "${target_dir}/runtime/node"

    # --- Step 2: Install Claude Code ---
    log "Installing claude-code@${CLAUDE_CODE_VERSION}..."

    local node_bin npm_bin
    if [[ "$os" == "win" ]]; then
        node_bin="${target_dir}/runtime/node/node.exe"
        npm_bin="${target_dir}/runtime/node/npm.cmd"
    else
        node_bin="${target_dir}/runtime/node/bin/node"
        npm_bin="${target_dir}/runtime/node/bin/npm"
    fi

    # Detect if we can run the target binary natively
    local host_os host_arch is_native
    host_os="$(uname -s)"
    host_arch="$(uname -m)"
    is_native=false

    # Map host arch to node naming
    local host_arch_node
    case "$host_arch" in
        x86_64|amd64) host_arch_node="x64" ;;
        aarch64|arm64) host_arch_node="arm64" ;;
        *) host_arch_node="unknown" ;;
    esac

    if [[ "$host_os" == "Linux" && "$os" == "linux" && "$host_arch_node" == "$arch" ]] || \
       [[ "$host_os" == "Darwin" && "$os" == "darwin" && "$host_arch_node" == "$arch" ]]; then
        is_native=true
    fi

    local npm_os_flag npm_cpu_flag
    case "$os" in
        linux)  npm_os_flag="linux" ;;
        darwin) npm_os_flag="darwin" ;;
        win)    npm_os_flag="win32" ;;
    esac
    npm_cpu_flag="$arch"

    # Install into target directory
    mkdir -p "${target_dir}/runtime/claude-code"

    # Claude Code v2 ships a native binary per platform (8 optionalDependencies).
    # postinstall picks the binary matching the *host*, so cross-builds get the
    # wrong binary. We install the wrapper with --ignore-scripts, then separately
    # pull the target platform's sub-package and overwrite bin/claude.exe.

    # Map our (os,arch) to Claude Code's npm platform key
    local cc_platform
    case "${os}-${arch}" in
        darwin-arm64) cc_platform="darwin-arm64" ;;
        darwin-x64)   cc_platform="darwin-x64" ;;
        linux-x64)    cc_platform="linux-x64" ;;
        linux-arm64)  cc_platform="linux-arm64" ;;
        win-x64)      cc_platform="win32-x64" ;;
        *) error "No Claude Code native package mapping for ${os}-${arch}" ;;
    esac

    log "Installing wrapper (no postinstall) for ${cc_platform}..."
    npm install \
        --prefix "${target_dir}/runtime/claude-code" \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        --ignore-scripts --no-fund --no-audit --force 2>&1 | tail -3

    # Resolve installed wrapper version so native sub-package version matches
    local wrapper_pkg_json="${target_dir}/runtime/claude-code/node_modules/@anthropic-ai/claude-code/package.json"
    local cc_version
    cc_version="$(python3 -c "import json; print(json.load(open('${wrapper_pkg_json}'))['version'])")"
    log "Wrapper version: ${cc_version}"

    # Pull target platform's native sub-package via `npm pack` (extracts tarball
    # directly, bypassing npm's optionalDependencies + host-platform filtering)
    local cc_cache_dir="${BUILD_DIR}/cc-natives"
    mkdir -p "$cc_cache_dir"
    local tarball_file="${cc_cache_dir}/claude-code-${cc_platform}-${cc_version}.tgz"
    if [[ ! -f "$tarball_file" ]]; then
        log "Downloading claude-code-${cc_platform}@${cc_version} tarball..."
        local packed
        packed=$(cd "$cc_cache_dir" && npm pack "@anthropic-ai/claude-code-${cc_platform}@${cc_version}" --silent)
        mv "${cc_cache_dir}/${packed}" "$tarball_file"
    else
        log "Using cached native tarball: $(basename "$tarball_file")"
    fi

    # Binary lives at top-level of tarball (e.g. package/claude or package/claude.exe)
    local bin_name="claude"
    [[ "$cc_platform" == win32-* ]] && bin_name="claude.exe"

    # Extract the single binary we need
    local wrapper_bin="${target_dir}/runtime/claude-code/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    tar xzf "$tarball_file" -C "$cc_cache_dir" "package/${bin_name}"
    cp -f "${cc_cache_dir}/package/${bin_name}" "$wrapper_bin"
    chmod +x "$wrapper_bin"

    # Clean up extracted staging so next platform doesn't reuse wrong binary
    rm -rf "${cc_cache_dir}/package"

    log "Installed native binary ($(file -b "$wrapper_bin" | cut -d, -f1-2))"

    # --- Step 2.5: Download Shadowsocks ---
    log "Setting up Shadowsocks proxy..."
    local ss_url ss_archive ss_bin
    ss_url="$(ss_download_url "$os" "$arch")"
    ss_bin="$(ss_binary_name "$os")"

    if [[ "$os" == "win" ]]; then
        ss_archive="${BUILD_DIR}/ss-${os}-${arch}.zip"
    else
        ss_archive="${BUILD_DIR}/ss-${os}-${arch}.tar.xz"
    fi

    if [[ ! -f "$ss_archive" ]]; then
        log "Downloading shadowsocks-rust v${SS_VERSION} for ${os}-${arch}..."
        curl -fSL --progress-bar -o "$ss_archive" "$ss_url" \
            || error "Failed to download shadowsocks from ${ss_url}"
    else
        log "Using cached SS: ${ss_archive}"
    fi

    # Extract only sslocal binary
    mkdir -p "${target_dir}/runtime/ss"
    if [[ "$os" == "win" ]]; then
        unzip -qoj "$ss_archive" "sslocal.exe" -d "${target_dir}/runtime/ss/" 2>/dev/null || true
    else
        tar -xJf "$ss_archive" --wildcards --strip-components=0 -C "${target_dir}/runtime/ss/" "*/sslocal" 2>/dev/null \
            || tar -xJf "$ss_archive" -C "${target_dir}/runtime/ss/" "sslocal" 2>/dev/null || true
        chmod +x "${target_dir}/runtime/ss/sslocal" 2>/dev/null || true
    fi

    # SS config is NOT bundled - it's delivered encrypted by the license server
    log "Shadowsocks binary bundled (config delivered at runtime)."

    # --- Step 3: Bundle license client (no plaintext credentials!) ---
    # Credentials, SS config, and state are now fetched from license server
    # and decrypted at runtime. Only the license client scripts are bundled.
    mkdir -p "${target_dir}/data/.claude" "${target_dir}/src"

    log "Bundling license client..."
    cp "${SCRIPT_DIR}/src/license-client.js" "${target_dir}/src/"
    cp "${SCRIPT_DIR}/src/heartbeat.js" "${target_dir}/src/"
    cp "${SCRIPT_DIR}/src/portable-claude.md" "${target_dir}/src/"

    # Inject build-time config into license-client.js
    # Read from configs/client.env if exists, otherwise use defaults
    local inject_servers='[]'
    local inject_key='change-me'
    if [[ -f "${SCRIPT_DIR}/configs/client.env" ]]; then
        set -a
        source "${SCRIPT_DIR}/configs/client.env"
        set +a
        # Build JSON array from comma-separated server list
        inject_servers=$(python3 -c "
import os, json
servers = os.environ.get('INTERNAL_SERVERS', '').split(',')
servers = [s.strip() for s in servers if s.strip()]
print(json.dumps(servers))
")
        inject_key="${ENCRYPT_KEY:-change-me}"
    fi
    sed -i "s|__INTERNAL_SERVERS__|${inject_servers}|g" "${target_dir}/src/license-client.js"
    sed -i "s|__ENCRYPT_KEY__|${inject_key}|g" "${target_dir}/src/license-client.js"
    log "Injected build-time config into license-client.js"

    # --- Step 3.5: Bundle Git for Windows ---
    if [[ "$os" == "win" ]]; then
        local mingit_dir="${BUILD_DIR}/MinGit"
        if [[ -d "$mingit_dir" ]]; then
            log "Bundling Git for Windows (MinGit + bash)..."
            cp -r "$mingit_dir" "${target_dir}/runtime/git"
        else
            warn "MinGit not found at ${mingit_dir}. Windows users need Git installed."
        fi
    fi

    # --- Step 4: Copy launcher ---
    log "Creating launcher scripts..."
    case "$os" in
        linux)
            cp "${SCRIPT_DIR}/src/launchers/claude.sh" "${target_dir}/claude.sh"
            chmod +x "${target_dir}/claude.sh"
            ;;
        darwin)
            cp "${SCRIPT_DIR}/src/launchers/claude.command" "${target_dir}/claude.command"
            chmod +x "${target_dir}/claude.command"
            ;;
        win)
            cp "${SCRIPT_DIR}/src/launchers/claude.bat" "${target_dir}/claude.bat"
            ;;
    esac

    # Copy first-run notice
    cp "${SCRIPT_DIR}/src/first-run.txt" "${target_dir}/README.txt"

    # --- Step 5: Package ---
    log "Packaging..."
    cd "${DIST_DIR}"
    if [[ "$os" == "win" ]]; then
        zip -qr "${target_name}.zip" "${target_name}/"
        log "Created: dist/${target_name}.zip"
    else
        tar -czf "${target_name}.tar.gz" "${target_name}/"
        log "Created: dist/${target_name}.tar.gz"
    fi
    cd "${SCRIPT_DIR}"

    log "Done: ${target_name}"
    echo ""
}

# =============================================================================
# Main
# =============================================================================
log "USB Claude - Portable Builder"
log "Node.js: v${NODE_VERSION} | Claude Code: ${CLAUDE_CODE_VERSION}"
echo ""

if [[ "$BUILD_ALL" == true ]]; then
    build_platform "linux" "x64"
    build_platform "linux" "arm64"
    build_platform "darwin" "x64"
    build_platform "darwin" "arm64"
    build_platform "win" "x64"
    log "All platforms built!"
    ls -lh "${DIST_DIR}"/*.{tar.gz,zip} 2>/dev/null
else
    build_platform "$PLATFORM_OS" "$PLATFORM_ARCH"
fi
