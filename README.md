# Claude Code Portable Edition

把 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 封装成便携版 —— 解压即用，无需安装，无需账号。

## Features

- **Zero Install** — 解压到任意目录（U盘/硬盘），双击启动
- **No Account Required** — 激活码授权，无需注册 Claude 账号
- **Multi-Platform** — Windows / macOS (Intel & Apple Silicon) / Linux
- **Built-in Network** — 内置网络加速，无需额外配置
- **License System** — 激活码管理、设备绑定、有效期控制、心跳检测
- **Security** — 凭证加密传输、敏感配置不落盘、系统指令防护

## Quick Start

### For Users

1. 获取对应平台的压缩包
2. 解压，双击启动脚本（`claude.bat` / `claude.command` / `claude.sh`）
3. 首次使用输入管理员提供的激活码
4. 开始使用 Claude Code

详细说明见 [产品文档](docs/PRODUCT.md)

### For Administrators

#### Prerequisites

- Linux build server with Node.js, Python 3, bash, curl
- Active Claude subscription (`claude login` 已完成)
- Network proxy node (optional)

#### Setup

```bash
# 1. Clone
git clone https://github.com/goddeng/Claude-Portable.git
cd usb-claude

# 2. Configure
cp configs/server.env.example configs/server.env
cp configs/client.env.example configs/client.env
cp configs/credentials.env.example configs/credentials.env
# Edit each file with your actual values

# 3. Configure SS proxy (optional)
cat > configs/ss-config.json << 'EOF'
{
    "server": "your-server.com",
    "server_port": 12345,
    "method": "aes-256-gcm",
    "password": "your-password",
    "timeout": 300
}
EOF

# 4. Start license server
pip install flask
python3 server/license_server.py

# 5. Build all platforms
./build.sh --all

# 6. Distribute dist/*.zip and dist/*.tar.gz to users
```

#### License Management

```bash
cd server

python3 admin.py stats                              # Overview
python3 admin.py list                                # Available codes
python3 admin.py list --used                         # Used codes
python3 admin.py devices                             # Activated devices
python3 admin.py generate --count 10 --days 90       # Generate codes
python3 admin.py note "CODE" "Customer name"         # Add note
python3 admin.py expiry --code "CODE" --days 60      # Extend expiry
python3 admin.py revoke --code "CODE"                # Revoke code
```

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│   Client (Portable) │  HTTP   │   License Server         │
│                     │ ◄─────► │                          │
│  Launcher           │         │  /api/activate           │
│   ├ License check   │         │  /api/heartbeat          │
│   ├ Decrypt creds   │         │  /api/credentials (enc)  │
│   ├ Start proxy     │         │                          │
│   ├ Heartbeat (60m) │         │  SQLite: codes, devices  │
│   └ Launch Claude   │         └──────────────────────────┘
└─────────────────────┘
```

## Get Activation Code

Need an activation code? Contact us:

- **Email**: goddeng@gmail.com
- **WeChat**: Scan QR code to join the user group (coming soon)
- **GitHub Issues**: Open an issue in this repo

## License

This project is a packaging/distribution tool for Claude Code. Claude Code itself is a product of [Anthropic](https://anthropic.com).
