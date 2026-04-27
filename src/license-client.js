#!/usr/bin/env node
/**
 * Claude Code Portable - License Client (v1.0.7+)
 *
 * Security model:
 *   - HTTPS-only. Self-signed cert pinned via SPKI (public key sha256 base64).
 *   - No server address baked in — user enters it once on first launch.
 *   - No symmetric key baked in — credential payload is encrypted with a
 *     per-user key derived from sha256(code+mac).
 *   - Every authenticated request carries Authorization: Bearer <code>.
 *   - Plugins / history / projects / sessions persist in DATA_DIR (USB).
 *   - Credentials (.credentials.json) live in DATA_DIR briefly; the launcher
 *     deletes them on session start and exit, so they never outlast a run.
 *
 * Exit codes:
 *   0 = success
 *   1 = activation required / refused
 *   2 = license expired/revoked
 *   3 = error (network, bad SPKI, etc.)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const os = require("os");
const readline = require("readline");

// --- Build-time injection (NOT a secret — SPKI is a public key hash) ---
const SPKI_PIN = "__SPKI_PIN__";

// --- Paths ---
// DATA_DIR: persistent storage on the USB drive
// CONFIG_DIR: Claude Code's config dir; lives under DATA_DIR so plugins, history,
//             projects, sessions all persist across runs.
// SERVER_FILE: only persistent client state we own — server URL + activation code.
const DATA_DIR = process.env.CLAUDE_PORTABLE_DATA || path.join(__dirname, "..", "data");
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(DATA_DIR, ".claude");
const SERVER_FILE = path.join(DATA_DIR, ".server.json");

// --- MAC ---
// Sort interface names and skip virtual adapters so the result is stable
// across runs regardless of OS enumeration order.
const VIRTUAL_PREFIX = /^(veth|br-|docker|virbr|vmnet|utun|tun|tap|lo|ppp|awdl|llw|anpi|bridge|ap[0-9])/i;
function getMac() {
  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces).sort();
  for (const name of names) {
    if (VIRTUAL_PREFIX.test(name)) continue;
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        return iface.mac.replace(/:/g, "").toLowerCase();
      }
    }
  }
  // Fallback: any non-internal non-zero MAC (sorted)
  for (const name of names) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        return iface.mac.replace(/:/g, "").toLowerCase();
      }
    }
  }
  return null;
}

// --- Prompt ---
// Queue-based reader: readline emits all available 'line' events as soon as
// data arrives, so a piped multi-line stdin can have all its lines consumed
// before the second await ask(). We capture every line into a queue and let
// ask() pull from the queue (or wait for the next line if it's empty).
const _lineQueue = [];
const _waiters = [];
let _rlClosed = false;
let _rl = null;
function _ensureRl() {
  if (_rl) return;
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  _rl.on("line", (line) => {
    const w = _waiters.shift();
    if (w) w(line.trim());
    else _lineQueue.push(line.trim());
  });
  _rl.on("close", () => {
    _rlClosed = true;
    while (_waiters.length > 0) _waiters.shift()("");
  });
}
function ask(prompt) {
  _ensureRl();
  process.stdout.write(prompt);
  if (_lineQueue.length > 0) return Promise.resolve(_lineQueue.shift());
  if (_rlClosed) return Promise.resolve("");
  return new Promise((resolve) => _waiters.push(resolve));
}

// --- HTTPS with SPKI pinning ---
function httpsPost(baseUrl, endpoint, body, bearerCode, timeout = 8000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(endpoint, baseUrl);
    } catch {
      return resolve(null);
    }
    if (url.protocol !== "https:") {
      return resolve(null);
    }

    const data = JSON.stringify(body || {});
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (bearerCode) headers["Authorization"] = `Bearer ${bearerCode}`;

    const req = https.request(url, {
      method: "POST",
      headers,
      timeout,
      rejectUnauthorized: false, // self-signed; we enforce SPKI pin ourselves
      checkServerIdentity: (_host, cert) => {
        if (!cert || !cert.pubkey) {
          return new Error("No peer public key");
        }
        const actual = crypto.createHash("sha256").update(cert.pubkey).digest("base64");
        if (actual !== SPKI_PIN) {
          return new Error(`SPKI pin mismatch (expected ${SPKI_PIN}, got ${actual})`);
        }
        return undefined;
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode === 200) {
          try { resolve({ ok: true, body: JSON.parse(text) }); }
          catch { resolve({ ok: false, status: 200 }); }
        } else {
          resolve({ ok: false, status: res.statusCode });
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

// --- Decrypt credentials (per-user key) ---
function decryptPayload(encryptedData, code, mac) {
  const keyHash = crypto.createHash("sha256").update(`${code}:${mac}`).digest();
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

// --- Progress bar ---
function showStep(step, total, msg) {
  const pct = Math.round((step / total) * 100);
  const filled = Math.round(pct / 5);
  const bar = "=".repeat(filled) + " ".repeat(20 - filled);
  process.stdout.write(`\r  Initializing... [${bar}] ${pct}% ${msg}`);
}

// --- Credential sync (requires active code) ---
async function fetchAndWriteCredentials(server, mac, code) {
  const resp = await httpsPost(server, "/api/credentials", { mac }, code, 8000);
  if (!resp || !resp.ok || !resp.body || !resp.body.ok || !resp.body.data) return false;

  try {
    const payload = decryptPayload(resp.body.data, code, mac);

    if (payload.credentials) {
      fs.writeFileSync(
        path.join(CONFIG_DIR, ".credentials.json"),
        JSON.stringify(payload.credentials, null, 2),
        { mode: 0o600 },
      );
    }
    if (payload.state) {
      fs.writeFileSync(
        path.join(CONFIG_DIR, ".claude.json"),
        JSON.stringify(payload.state, null, 2),
      );
    }
    if (payload.ss_config) {
      const ss = payload.ss_config;
      // Launcher reads this immediately, then deletes it — never lingers on disk.
      fs.writeFileSync(
        path.join(CONFIG_DIR, ".ss_args"),
        `-s ${ss.server}:${ss.server_port} -m ${ss.method} -k ${ss.password} --protocol http --local-addr 127.0.0.1:51080`,
        { mode: 0o600 },
      );
    }
    return true;
  } catch {
    return false;
  }
}

// --- Claude settings ---
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

// --- Normalize user-entered server address into https://host:port ---
function normalizeServer(input) {
  const stripped = input.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return "https://" + stripped;
}

// --- Setup banner ---
function printBanner() {
  console.log("");
  console.log("  +=======================================+");
  console.log("  |     Claude Code Portable Edition      |");
  console.log("  +=======================================+");
  console.log("");
}

// --- Prompt user for both server and code ---
async function promptServerAndCode() {
  const serverInput = await ask("  Enter license server (host:port): ");
  if (!serverInput) { console.error("  No address entered."); process.exit(3); }
  const codeInput = await ask("  Enter activation code: ");
  if (!codeInput) { console.error("  No code entered."); process.exit(1); }
  return { server: normalizeServer(serverInput), code: codeInput };
}

// --- Main ---
async function main() {
  const mac = getMac();
  if (!mac) { console.error("  Error: Cannot detect network adapter."); process.exit(3); }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let savedConfig = loadJson(SERVER_FILE);
  let server = savedConfig?.server ? normalizeServer(savedConfig.server) : null;
  let savedCode = savedConfig?.code || null;

  // Try saved config first if both pieces are present.
  let result = null;
  if (server && savedCode) {
    showStep(1, 5, "Checking license");
    result = await httpsPost(server, "/api/activate", { mac, code: savedCode }, null, 8000);
  }

  // If no save, or saved config failed for any reason (unreachable / refused),
  // wipe the save and re-prompt for BOTH server and code, retry once.
  if (!result || !result.ok || !result.body?.ok) {
    if (server && savedCode) {
      console.log("");
      if (result === null) {
        console.error("  Saved server is unreachable or its certificate has changed.");
      } else {
        console.error(`  Saved activation refused${result.status ? " (HTTP " + result.status + ")" : ""}.`);
      }
      console.log("  Clearing local config - please re-enter server and activation code.");
      try { fs.unlinkSync(SERVER_FILE); } catch {}
      console.log("");
    } else {
      printBanner();
    }

    const entered = await promptServerAndCode();
    server = entered.server;
    savedCode = entered.code;

    showStep(1, 5, "Activating");
    result = await httpsPost(server, "/api/activate", { mac, code: savedCode }, null, 8000);
    if (result === null) {
      console.error("\n  Error: Server unreachable or certificate mismatch.");
      console.error("  Check network or contact your administrator.");
      process.exit(3);
    }
    if (!result.ok || !result.body?.ok) {
      console.error(`\n  Activation failed${result.status ? " (HTTP " + result.status + ")" : ""}.`);
      process.exit(1);
    }
  }

  // Success — persist server + code (overwrites any stale save)
  saveJson(SERVER_FILE, { server, code: savedCode });

  showStep(2, 5, "Syncing credentials");
  const credsOk = await fetchAndWriteCredentials(server, mac, savedCode);
  if (!credsOk) {
    console.error("\n  Warning: credential sync failed (will retry on next launch).");
  }

  showStep(3, 5, "Loading config");
  writeSettings();

  showStep(4, 5, "Starting network");
  saveJson(path.join(CONFIG_DIR, ".heartbeat.json"), {
    mac, servers: [server], interval: 60 * 60 * 1000, code: savedCode,
  });

  showStep(5, 5, "Ready");
  console.log("\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  Error: ${e.message}`);
  process.exit(3);
});
