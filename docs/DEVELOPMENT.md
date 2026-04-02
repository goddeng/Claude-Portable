# Development Guide

## Architecture

The build system creates a self-contained portable package:

```
claude-portable-{os}-{arch}/
├── runtime/
│   ├── node/              # Node.js v22 portable binary
│   └── claude-code/       # npm-installed @anthropic-ai/claude-code
├── data/
│   ├── .claude/           # Config dir (CLAUDE_CONFIG_DIR points here)
│   │   └── .credentials.json  # OAuth tokens
│   └── credentials.env    # API key (optional, loaded by launcher)
├── claude.{bat,command,sh} # Platform-specific launcher
└── README.txt
```

### How Portability Works

1. **Node.js**: Official prebuilt binaries, no installation needed
2. **Claude Code**: Installed via npm into local prefix (not global)
3. **Config isolation**: `CLAUDE_CONFIG_DIR` env var tells Claude Code to use `data/.claude/` instead of `~/.claude/`
4. **Credentials**: OAuth tokens copied from build machine's `~/.claude/.credentials.json`

### Launcher Flow

1. Resolve script's own directory as portable root
2. Set `PATH` to include bundled Node.js
3. Set `CLAUDE_CONFIG_DIR` to `data/.claude/`
4. **Auto-refresh credentials** from build server (`http://YOUR_SERVER:9099`), fall back to local if unreachable
5. Source `credentials.env` if present (optional API key)
6. Show first-run notice on initial launch
7. Exec `claude` from bundled npm installation

## How to Build

### Prerequisites

- bash, curl, tar, zip (standard on Linux/macOS)
- Internet connection (to download Node.js and claude-code)
- Active Claude credentials in `~/.claude/.credentials.json`

### Build for Current Platform

```bash
./build.sh
```

### Build for Specific Platform

```bash
./build.sh --platform darwin --arch arm64   # macOS Apple Silicon
./build.sh --platform win --arch x64        # Windows x64
```

### Build All

```bash
./build.sh --all
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--platform` | Target OS: linux, darwin, win | auto-detect |
| `--arch` | Target arch: x64, arm64 | auto-detect |
| `--node-version` | Node.js version | 22.14.0 |
| `--claude-version` | Claude Code npm version | latest |
| `--credentials` | Path to credentials.env | configs/credentials.env |
| `--all` | Build all platforms | false |

## Cross-Platform Building

When building for a different platform than the host:
- Node.js binary is downloaded for the target platform
- npm install uses `--os` and `--cpu` flags for platform-specific native modules
- The target binary cannot be executed on the host (only packaged)

## Credential Management

### Auto-refresh (default)

Every launch, the launcher tries to fetch fresh credentials from the build server:
- `http://YOUR_SERVER:9099/credentials.json` → `.credentials.json`
- `http://YOUR_SERVER:9099/state.json` → `.claude.json`

If the server is unreachable (timeout 3s), local credentials are used as fallback.

### Credential Server

A systemd service on the build machine serves the latest tokens:

```bash
# Status
systemctl status claude-credentials

# Restart
systemctl restart claude-credentials

# Logs
journalctl -u claude-credentials -f
```

The server reads `~/.claude/.credentials.json` and refreshes every 30 minutes.

### Manual Update

```bash
./update-credentials.sh /path/to/portable-dir
```

### Important: env var vs file auth

**DO NOT use `CLAUDE_CODE_OAUTH_TOKEN` env var** for interactive mode. It is hardcoded to `user:inference` scope only, which blocks interactive mode. Always use `.credentials.json` file, which preserves all 5 scopes.

## Adding a New Platform

1. Add Node.js URL pattern in `build.sh` → `node_download_url()`
2. Create launcher script in `src/launchers/`
3. Add case in `build.sh` → `build_platform()` step 4
4. Add to the `--all` build list
