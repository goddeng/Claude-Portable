# Claude Code Portable Edition

<p align="center">
  <strong>Zero-install, multi-platform, activation-code licensed portable packaging of Claude Code CLI</strong>
</p>

<p align="center">
  <a href="#features">Features</a> |
  <a href="#supported-platforms">Platforms</a> |
  <a href="#quick-start">Quick Start</a> |
  <a href="#get-activation-code">Get Code</a>
</p>

---

Put [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on a USB drive. Unzip, double-click, done. No installation, no account, no network setup.

## Features

- **Zero Install** - Unzip to any directory (USB / HDD), double-click to launch
- **No Account Required** - Activation code authorization, no Claude account needed
- **Multi-Platform** - Windows / macOS (Intel & Apple Silicon) / Linux
- **Built-in Network** - Integrated network acceleration, no extra proxy configuration
- **License System** - Code management, device binding, expiration control, heartbeat monitoring
- **Security** - Encrypted credential delivery, no plaintext secrets on disk, system prompt protection

## Supported Platforms

| Platform | File | Architecture |
|----------|------|-------------|
| Windows | `claude-portable-win-x64.zip` | Intel / AMD 64-bit |
| macOS | `claude-portable-darwin-arm64.tar.gz` | Apple M1/M2/M3/M4 |
| macOS | `claude-portable-darwin-x64.tar.gz` | Intel Mac |
| Linux | `claude-portable-linux-x64.tar.gz` | Intel / AMD 64-bit |
| Linux | `claude-portable-linux-arm64.tar.gz` | ARM 64-bit |

## Quick Start

### For Users

1. Get the package for your platform from the administrator
2. Unzip, double-click the launcher (`claude.bat` / `claude.command` / `claude.sh`)
3. Enter the activation code on first launch
4. Start using Claude Code

See [Product Guide](docs/PRODUCT.md) for details.

### For Administrators

#### Prerequisites

- Linux build server with Python 3, bash, curl, tar, zip
- Active Claude subscription (`claude login` completed)
- Network proxy node (optional)

#### Setup

```bash
# 1. Clone
git clone https://github.com/goddeng/Claude-Portable.git
cd Claude-Portable

# 2. Configure server
cp configs/server.env.example configs/server.env
# Edit: set ENCRYPT_KEY, INTERNAL_PREFIXES, credential paths

# 3. Configure client
cp configs/client.env.example configs/client.env
# Edit: set LICENSE_SERVER_LAN, LICENSE_SERVER_WAN, ENCRYPT_KEY

# 4. Configure proxy (optional)
cp configs/ss-config.json.example configs/ss-config.json
# Edit: set your proxy server details

# 5. Start license server
pip install flask
python3 server/license_server.py

# 6. Build all platforms
./build.sh --all

# 7. Distribute dist/ packages to users
```

#### License Management

```bash
cd server

python3 admin.py stats                              # Overview
python3 admin.py list                                # Available codes
python3 admin.py list --used                         # Used codes
python3 admin.py devices                             # Activated devices
python3 admin.py generate --count 10 --days 90       # Generate 10 codes, 90-day expiry
python3 admin.py note "CODE" "Customer name"         # Add note to code
python3 admin.py expiry --code "CODE" --days 60      # Extend expiry
python3 admin.py revoke --code "CODE"                # Revoke a code
python3 admin.py revoke --mac "MACADDR"              # Revoke a device
```

## Architecture

```
┌──────────────────────┐          ┌──────────────────────────┐
│   Client (Portable)  │   HTTP   │   License Server         │
│                      │ ◄──────► │                          │
│  Launcher            │          │  /api/activate           │
│   ├ License check    │          │  /api/heartbeat          │
│   ├ Decrypt creds    │          │  /api/credentials (enc)  │
│   ├ Start proxy      │          │                          │
│   ├ Heartbeat (60m)  │          │  SQLite: codes, devices  │
│   └ Launch Claude    │          └──────────────────────────┘
└──────────────────────┘

Startup flow:
  Double-click → License verify → Decrypt credentials
  → Start network proxy → Start heartbeat → Launch Claude Code
```

## Security

| Layer | Measure |
|-------|---------|
| Credential delivery | AES-encrypted, MAC-bound decryption key |
| Proxy config | Delivered at runtime, never saved to disk |
| System prompt | Claude refuses to inspect or reveal system internals |
| File permissions | Read/Edit/Glob/Grep blocked on portable directory |
| Activation | One code per device (MAC binding) |
| Monitoring | 60-minute heartbeat, server-side revocation |

## Get Activation Code

Need an activation code? Contact us:

- **Email**: goddeng@gmail.com
- **WeChat**: Join the user group (coming soon)
- **GitHub Issues**: [Open an issue](https://github.com/goddeng/Claude-Portable/issues)

## License

MIT License - See [LICENSE](LICENSE) file.

This project is a packaging/distribution tool. Claude Code is a product of [Anthropic](https://anthropic.com).
