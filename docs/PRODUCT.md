# Claude Code 便携版

## 产品简介

Claude Code 便携版是一款基于 Anthropic Claude Code CLI 封装的便携式 AI 编程助手。用户无需安装任何软件、无需注册 Claude 账号、无需配置网络环境，只需解压到任意目录（U盘、硬盘均可），双击即可启动使用。

## 核心特性

- **零安装** — 解压即用，不修改系统环境，不写注册表
- **免账号** — 无需注册 Claude 账号，通过激活码授权使用
- **便携性** — 可放在 U 盘随身携带，换电脑即插即用
- **多平台** — 支持 Windows、macOS（Intel / Apple Silicon）、Linux
- **网络内置** — 内置网络加速通道，无需额外配置科学上网
- **安全性** — 敏感配置加密传输，本地无明文残留

## 支持平台

| 平台 | 文件 | 芯片架构 |
|------|------|---------|
| Windows | `claude-portable-win-x64.zip` | Intel / AMD 64位 |
| macOS | `claude-portable-darwin-arm64.tar.gz` | Apple M1/M2/M3/M4 |
| macOS | `claude-portable-darwin-x64.tar.gz` | Intel Mac |
| Linux | `claude-portable-linux-x64.tar.gz` | Intel / AMD 64位 |
| Linux | `claude-portable-linux-arm64.tar.gz` | ARM 64位 |

## 使用方法

### 1. 获取安装包

从管理员处获取对应平台的压缩包。

### 2. 解压

- **Windows**：右键 → 解压到当前文件夹
- **macOS / Linux**：`tar -xzf claude-portable-xxx.tar.gz`

### 3. 启动

| 平台 | 操作 |
|------|------|
| Windows | 双击 `claude.bat` |
| macOS | 双击 `claude.command` |
| Linux | 终端运行 `./claude.sh` |

### 4. 激活

首次启动时，系统会提示输入激活码：

```
  Initializing... [====                ] 20% Checking license

  Please enter activation code: ________________________________
```

输入管理员提供的 32 位激活码，回车即可。激活码与设备绑定，有效期内无需重复输入。

> **注意**：如果在公司内网使用，可免激活码自动授权。

### 5. 开始使用

激活成功后，Claude Code 自动启动，进入交互式命令行界面。你可以：

- 直接对话，让 Claude 帮你写代码、分析问题、解释概念
- 让 Claude 读取和修改你的项目文件
- 执行终端命令
- 搜索网络信息

## 激活码说明

| 项目 | 说明 |
|------|------|
| 格式 | 32 位字母数字混合字符串 |
| 绑定 | 一码一机，激活后绑定设备 MAC 地址 |
| 有效期 | 由管理员设定，到期后需续期或更换新码 |
| 续期 | 联系管理员延长有效期，无需更换激活码 |
| 过期 | 过期后启动会提示重新输入激活码 |

## 常见问题

**Q: 激活码过期了怎么办？**
A: 联系管理员续期。续期后无需重新输入，下次启动自动生效。

**Q: 换了电脑怎么办？**
A: 需要新的激活码。一个激活码只能绑定一台设备。

**Q: 可以同时在多台电脑使用吗？**
A: 可以，每台电脑需要独立的激活码。

**Q: 没有网络能用吗？**
A: Claude Code 需要网络连接才能工作。便携版已内置网络通道，确保能连接到 Claude 服务。

**Q: Windows 提示"无法识别的应用"？**
A: 点击"更多信息" → "仍要运行"即可。

**Q: macOS 提示"无法打开，因为无法验证开发者"？**
A: 系统设置 → 隐私与安全 → 仍然允许。

## 封装技术概览

便携版的封装基于以下技术方案：

### 架构

```
claude-portable/
├── claude.{bat/sh/command}    # 平台启动器
├── runtime/
│   ├── node/                  # Node.js 便携运行时
│   ├── claude-code/           # Claude Code CLI (npm 包)
│   ├── ss/                    # 网络加速组件
│   └── git/                   # Git 工具链 (仅 Windows)
├── src/
│   ├── license-client.js      # 授权客户端
│   └── heartbeat.js           # 心跳守护
└── data/                      # 运行时数据（凭证、配置）
```

### 封装流程

1. **运行时打包** — 下载目标平台的 Node.js 预编译二进制，将 Claude Code npm 包安装到本地目录，实现免安装运行
2. **网络通道集成** — 打包网络加速组件的平台二进制，配置信息由服务端加密下发，客户端内存解密使用，不在本地存储
3. **授权系统** — 构建授权服务器，管理激活码生成、设备绑定、有效期控制、心跳检测
4. **凭证管理** — Claude API 凭证由服务端统一管理，通过设备 MAC 地址加密后传输到客户端，自动刷新
5. **安全加固** — 系统指令限制 Claude 访问便携目录，文件权限阻止工具读取系统文件，敏感配置不落盘
6. **跨平台构建** — 一套构建脚本自动生成 5 个平台包（Windows x64、macOS x64/ARM64、Linux x64/ARM64）

### 启动流程

```
双击启动
  → 授权验证（内网自动 / 外网输入激活码）
  → 设备 MAC 绑定
  → 加密获取凭证和网络配置
  → 启动网络加速通道
  → 启动心跳守护（60分钟周期）
  → 启动 Claude Code 交互界面
```

### 构建命令

```bash
./build.sh                           # 构建当前平台
./build.sh --platform win --arch x64 # 构建 Windows 版
./build.sh --all                     # 构建全平台
```

### 管理命令

```bash
python3 admin.py stats                              # 查看统计
python3 admin.py list                                # 查看可用激活码
python3 admin.py list --used                         # 查看已使用的激活码
python3 admin.py devices                             # 查看已激活设备
python3 admin.py generate --count 10 --days 90       # 生成 10 个激活码，90天有效
python3 admin.py note "激活码" "备注内容"               # 添加备注
python3 admin.py expiry --code "激活码" --days 60     # 延长有效期
python3 admin.py revoke --code "激活码"               # 吊销激活码
python3 admin.py revoke --mac "MAC地址"               # 吊销设备
```
