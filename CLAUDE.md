# USB Claude - Portable Claude Code

A build system that packages Claude Code CLI into a portable, zero-install package.

## Project Structure

```
usb-claude/
├── build.sh                     # Main build script
├── configs/
│   ├── credentials.env          # Real credentials (gitignored)
│   └── credentials.env.example  # Template
├── src/
│   ├── launchers/
│   │   ├── claude.bat           # Windows launcher
│   │   ├── claude.command       # macOS launcher (Finder double-click)
│   │   └── claude.sh            # Linux launcher
│   └── first-run.txt            # README bundled into output
├── dist/                        # Build output (gitignored)
└── docs/
    └── DEVELOPMENT.md
```

## Build Commands

```bash
./build.sh                           # Build for current platform
./build.sh --platform win --arch x64 # Cross-build for Windows
./build.sh --all                     # Build all platforms
```

## Key Design Decisions

- `CLAUDE_CONFIG_DIR` env var redirects Claude Code config to portable `data/.claude/`
- OAuth credentials from `~/.claude/.credentials.json` are bundled at build time
- Node.js portable binary is bundled (no system install needed)
- Each platform gets its own launcher script format for double-click UX
