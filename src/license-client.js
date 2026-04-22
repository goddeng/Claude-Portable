#!/usr/bin/env node
/**
 * Claude Code Portable - License Client
 *
 * Flow:
 *   1. Try internal server silently → if works, auto-activate, done
 *   2. If not, load saved server config from .server.json
 *   3. If no saved config, prompt for server address + activation code
 *   4. Save server + code locally for next time
 *
 * Exit codes:
 *   0 = success
 *   1 = activation required
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

// --- Build-time config (injected by build.sh, not in GitHub source) ---
const INTERNAL_SERVERS = __INTERNAL_SERVERS__;
const ENCRYPT_KEY = "__ENCRYPT_KEY__";

// --- Paths ---
const HEARTBEAT_INTERVAL = 60 * 60 * 1000;
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

// --- HTTP helpers ---
function httpPost(baseUrl, endpoint, body, timeout = 5000) {
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
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error("Invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

async function tryServer(server, endpoint, body, timeout) {
  try {
    return await httpPost(server, endpoint, body, timeout);
  } catch {
    return null;
  }
}

// --- Decryption ---
function decryptPayload(encryptedData, mac) {
  const keyHash = crypto.createHash("sha256").update(`${ENCRYPT_KEY}:${mac}`).digest();
  const buf = Buffer.from(encryptedData, "base64");
  const result = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    result[i] = buf[i] ^ keyHash[i % keyHash.length];
  }
  return JSON.parse(result.toString("utf8"));
}

// --- Persistence ---
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// --- Progress ---
function showStep(step, total, msg) {
  const pct = Math.round((step / total) * 100);
  const filled = Math.round(pct / 5);
  const bar = "=".repeat(filled) + " ".repeat(20 - filled);
  process.stdout.write(`\r  Initializing... [${bar}] ${pct}% ${msg}`);
}

// --- Write credentials to disk ---
async function fetchAndWriteCredentials(server, mac) {
  const credResult = await tryServer(server, "/api/credentials", { mac }, 8000);
  if (!credResult || !credResult.ok || !credResult.data) return;

  try {
    const payload = decryptPayload(credResult.data, mac);

    if (payload.credentials) {
      fs.writeFileSync(path.join(CONFIG_DIR, ".credentials.json"), JSON.stringify(payload.credentials, null, 2), { mode: 0o600 });
    }
    if (payload.state) {
      fs.writeFileSync(path.join(CONFIG_DIR, ".claude.json"), JSON.stringify(payload.state, null, 2));
    }
    if (payload.ss_config) {
      const ss = payload.ss_config;
      fs.writeFileSync(path.join(DATA_DIR, ".ss_args"),
        `-s ${ss.server}:${ss.server_port} -m ${ss.method} -k ${ss.password} --protocol http --local-addr 127.0.0.1:51080`,
        { mode: 0o600 });
    }
  } catch {}
}

// --- Write settings ---
function writeSettings() {
  const portableRoot = path.join(__dirname, "..");
  fs.writeFileSync(path.join(CONFIG_DIR, "settings.json"), JSON.stringify({
    permissions: {
      allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebFetch", "WebSearch", "NotebookEdit", "mcp__*"],
      deny: [
        `Read(${portableRoot}/**)`, `Edit(${portableRoot}/**)`,
        `Glob(${portableRoot}/**)`, `Grep(${portableRoot}/**)`,
      ],
    },
  }, null, 2));
}

// --- Main ---
async function main() {
  const mac = getMac();
  if (!mac) { console.error("  Error: Cannot detect network adapter."); process.exit(3); }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // ===== Phase 1: Try internal servers silently =====
  showStep(1, 5, "Checking license");

  for (const server of INTERNAL_SERVERS) {
    const result = await tryServer(server, "/api/activate", { mac }, 3000);
    if (result && result.ok) {
      // Internal network - auto activated
      saveJson(LICENSE_FILE, { mac, activated: true, server, expires_at: result.expires_at, ts: Date.now() });

      showStep(2, 5, "Syncing credentials");
      await fetchAndWriteCredentials(server, mac);

      showStep(3, 5, "Loading config");
      writeSettings();

      showStep(4, 5, "Starting network");
      saveJson(path.join(DATA_DIR, ".heartbeat.json"), { mac, servers: [server], interval: HEARTBEAT_INTERVAL });

      showStep(5, 5, "Ready");
      console.log("\n");
      process.exit(0);
    }
  }

  // ===== Phase 2: External mode - use saved or prompt =====
  let savedConfig = loadJson(SERVER_FILE);
  let server = savedConfig?.server;
  let savedCode = savedConfig?.code;

  // If no saved server, prompt
  if (!server) {
    console.log("");
    console.log("  +=======================================+");
    console.log("  |     Claude Code Portable Edition      |");
    console.log("  |     First-time Setup                  |");
    console.log("  +=======================================+");
    console.log("");

    server = await ask("  Enter server address (e.g. 1.2.3.4:9099): ");
    if (!server) { console.error("  No address entered."); process.exit(3); }
    if (!server.startsWith("http")) server = "http://" + server;
    server = server.replace(/\/+$/, "");
  }

  // Try activate with saved code first
  showStep(1, 5, "Checking license");
  let result = null;

  if (savedCode) {
    result = await tryServer(server, "/api/activate", { mac, code: savedCode }, 8000);
  }

  if (!result) {
    result = await tryServer(server, "/api/activate", { mac }, 8000);
  }

  if (!result) {
    console.error("\n  Error: Server unreachable.");
    // Offline fallback
    const local = loadJson(LICENSE_FILE);
    if (local && local.mac === mac && local.activated && fs.existsSync(path.join(CONFIG_DIR, ".credentials.json"))) {
      showStep(5, 5, "Ready (offline)");
      console.log("\n");
      process.exit(0);
    }
    console.error("  Check server address or network connection.");
    process.exit(3);
  }

  // Saved code is no longer valid (revoked / expired / taken by another device).
  // Drop it and re-prompt — otherwise the user is stuck forever.
  const staleSavedCode = savedCode && !result.ok && !result.need_code && (
    /invalid|revoked|expired|already used|another device/i.test(result.error || "")
  );
  if (staleSavedCode) {
    console.log("");
    console.error(`  Saved activation code is no longer valid: ${result.error}`);
    console.log("  Please enter a new activation code (contact admin if needed).");
    try { fs.unlinkSync(SERVER_FILE); } catch {}
    try { fs.unlinkSync(LICENSE_FILE); } catch {}
    savedCode = null;
    result = { ok: false, need_code: true };
  }

  // Need activation code
  if (!result.ok && result.need_code) {
    console.log("");
    const code = await ask("  Enter activation code: ");
    if (!code) { console.error("  No code entered."); process.exit(1); }
    savedCode = code;
    showStep(1, 5, "Activating");
    result = await tryServer(server, "/api/activate", { mac, code }, 8000);
  }

  if (!result || !result.ok) {
    console.error(`\n  Activation failed: ${result?.error || "Unknown error"}`);
    process.exit(result?.error?.includes("expired") ? 2 : 1);
  }

  // Save server + code for next time
  saveJson(SERVER_FILE, { server, code: savedCode });
  saveJson(LICENSE_FILE, { mac, activated: true, server, expires_at: result.expires_at, ts: Date.now() });

  // Fetch credentials
  showStep(2, 5, "Syncing credentials");
  await fetchAndWriteCredentials(server, mac);

  showStep(3, 5, "Loading config");
  writeSettings();

  showStep(4, 5, "Starting network");
  saveJson(path.join(DATA_DIR, ".heartbeat.json"), { mac, servers: [server], interval: HEARTBEAT_INTERVAL });

  showStep(5, 5, "Ready");
  console.log("\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  Error: ${e.message}`);
  process.exit(3);
});
