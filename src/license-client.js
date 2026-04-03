#!/usr/bin/env node
/**
 * Claude Code Portable - License Client
 * Handles server setup, activation, heartbeat, and credential decryption.
 * Called by platform launchers before starting Claude Code.
 *
 * Exit codes:
 *   0 = success, credentials written
 *   1 = activation required (need code input)
 *   2 = license expired/revoked
 *   3 = error
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const os = require("os");
const readline = require("readline");

// --- Config ---
const HEARTBEAT_INTERVAL = 60 * 60 * 1000; // 60 minutes
const DATA_DIR = process.env.CLAUDE_PORTABLE_DATA || path.join(__dirname, "..", "data");
const CONFIG_DIR = path.join(DATA_DIR, ".claude");
const LICENSE_FILE = path.join(DATA_DIR, ".license.json");
const SERVER_FILE = path.join(DATA_DIR, ".server.json");

// --- MAC Address ---
function getMac() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        return iface.mac.replace(/:/g, "").toLowerCase();
      }
    }
  }
  return null;
}

// --- User input ---
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// --- Server config ---
function loadServerConfig() {
  try {
    return JSON.parse(fs.readFileSync(SERVER_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveServerConfig(config) {
  fs.mkdirSync(path.dirname(SERVER_FILE), { recursive: true });
  fs.writeFileSync(SERVER_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function ensureServerConfig() {
  let config = loadServerConfig();
  if (config && config.servers && config.servers.length > 0 && config.encryptKey) {
    return config;
  }

  console.log("");
  console.log("  +=======================================+");
  console.log("  |     Claude Code Portable Edition      |");
  console.log("  |     First-time Setup                  |");
  console.log("  +=======================================+");
  console.log("");

  const serverAddr = await ask("  Enter server address (e.g. http://1.2.3.4:9099): ");
  if (!serverAddr) {
    console.error("  No server address entered.");
    process.exit(3);
  }

  // Normalize: ensure http:// prefix
  let normalized = serverAddr;
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = "http://" + normalized;
  }
  // Remove trailing slash
  normalized = normalized.replace(/\/+$/, "");

  const encryptKey = await ask("  Enter encryption key: ");
  if (!encryptKey) {
    console.error("  No encryption key entered.");
    process.exit(3);
  }

  config = { servers: [normalized], encryptKey };
  saveServerConfig(config);
  console.log("  Server configured.\n");
  return config;
}

// --- HTTP helpers ---
function httpPost(baseUrl, endpoint, body, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const mod = url.protocol === "https:" ? https : http;
    const data = JSON.stringify(body);

    const req = mod.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout,
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error("Invalid JSON response"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

async function apiCall(servers, endpoint, body) {
  for (const server of servers) {
    try {
      return await httpPost(server, endpoint, body);
    } catch {
      continue;
    }
  }
  return null;
}

// --- Decryption ---
function xorDecrypt(encrypted, key) {
  const keyHash = crypto.createHash("sha256").update(key).digest();
  const buf = Buffer.from(encrypted, "base64");
  const result = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    result[i] = buf[i] ^ keyHash[i % keyHash.length];
  }
  return result.toString("utf8");
}

function decryptPayload(encryptedData, mac, encryptKey) {
  const combinedKey = `${encryptKey}:${mac}`;
  const json = xorDecrypt(encryptedData, combinedKey);
  return JSON.parse(json);
}

// --- License state ---
function loadLicense() {
  try {
    return JSON.parse(fs.readFileSync(LICENSE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveLicense(data) {
  fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
}

// --- Progress ---
function showStep(step, total, msg) {
  const pct = Math.round((step / total) * 100);
  const filled = Math.round(pct / 5);
  const bar = "=".repeat(filled) + " ".repeat(20 - filled);
  process.stdout.write(`\r  Initializing... [${bar}] ${pct}% ${msg}`);
}

// --- Main flow ---
async function main() {
  const mac = getMac();
  if (!mac) {
    console.error("  Error: Cannot detect network adapter.");
    process.exit(3);
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Step 0: Ensure server is configured
  const serverConfig = await ensureServerConfig();
  const { servers, encryptKey } = serverConfig;

  // Step 1: Activate
  showStep(1, 5, "Checking license");

  let activateResult = await apiCall(servers, "/api/activate", { mac });

  if (!activateResult) {
    // Server unreachable - check local license
    const local = loadLicense();
    if (local && local.mac === mac && local.activated) {
      showStep(3, 5, "Offline mode");
      if (fs.existsSync(path.join(CONFIG_DIR, ".credentials.json"))) {
        showStep(5, 5, "Ready (offline)");
        console.log("\n");
        process.exit(0);
      }
    }
    console.error("\n  Error: License server unreachable and no local license.");
    console.error("  To reconfigure server, delete: " + SERVER_FILE);
    process.exit(3);
  }

  if (!activateResult.ok && activateResult.need_code) {
    console.log(""); // newline after progress bar
    const code = await ask("  Please enter activation code: ");
    if (!code) {
      console.error("  No code entered.");
      process.exit(1);
    }
    showStep(1, 5, "Activating");
    activateResult = await apiCall(servers, "/api/activate", { mac, code });
  }

  if (!activateResult || !activateResult.ok) {
    console.error(`\n  Activation failed: ${activateResult?.error || "Unknown error"}`);
    process.exit(activateResult?.error?.includes("expired") ? 2 : 1);
  }

  saveLicense({ mac, activated: true, expires_at: activateResult.expires_at, ts: Date.now() });

  // Step 2: Fetch encrypted credentials
  showStep(2, 5, "Syncing credentials");

  const credResult = await apiCall(servers, "/api/credentials", { mac });
  if (credResult && credResult.ok && credResult.data) {
    try {
      const payload = decryptPayload(credResult.data, mac, encryptKey);

      if (payload.credentials) {
        fs.writeFileSync(path.join(CONFIG_DIR, ".credentials.json"), JSON.stringify(payload.credentials, null, 2), { mode: 0o600 });
      }
      if (payload.state) {
        fs.writeFileSync(path.join(CONFIG_DIR, ".claude.json"), JSON.stringify(payload.state, null, 2));
      }
      if (payload.ss_config) {
        const ss = payload.ss_config;
        const ssArgs = `-s ${ss.server}:${ss.server_port} -m ${ss.method} -k ${ss.password} --protocol http --local-addr 127.0.0.1:51080`;
        fs.writeFileSync(path.join(DATA_DIR, ".ss_args"), ssArgs, { mode: 0o600 });
      }
    } catch (e) {
      console.error(`\n  Warning: Failed to decrypt credentials: ${e.message}`);
    }
  }

  // Step 3: Write settings (auto-accept permissions)
  showStep(3, 5, "Loading config");

  const portableRoot = path.join(__dirname, "..");
  const settingsPath = path.join(CONFIG_DIR, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    permissions: {
      allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebFetch", "WebSearch", "NotebookEdit", "mcp__*"],
      deny: [
        `Read(${portableRoot}/**)`,
        `Edit(${portableRoot}/**)`,
        `Glob(${portableRoot}/**)`,
        `Grep(${portableRoot}/**)`,
      ],
    },
  }, null, 2));

  // Step 4: Start heartbeat timer info
  showStep(4, 5, "Starting network");

  const heartbeatInfo = { mac, servers, interval: HEARTBEAT_INTERVAL };
  fs.writeFileSync(path.join(DATA_DIR, ".heartbeat.json"), JSON.stringify(heartbeatInfo));

  // Step 5: Done
  showStep(5, 5, "Ready");
  console.log("\n");

  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  Error: ${e.message}`);
  process.exit(3);
});
