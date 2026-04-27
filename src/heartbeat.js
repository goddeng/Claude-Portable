#!/usr/bin/env node
/**
 * Heartbeat daemon (v1.0.7+) — HTTPS w/ SPKI pin + Bearer auth.
 * Runs in background, pings license server every 60 min.
 * Writes .license_expired flag (in DATA_DIR) on explicit revoke/expire.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const SPKI_PIN = "__SPKI_PIN__";

const DATA_DIR = process.env.CLAUDE_PORTABLE_DATA || path.join(__dirname, "..", "data");
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(DATA_DIR, ".claude");
const HEARTBEAT_FILE = path.join(CONFIG_DIR, ".heartbeat.json");
const KILL_FLAG = path.join(DATA_DIR, ".license_expired");

try { fs.unlinkSync(KILL_FLAG); } catch {}

function httpsPost(baseUrl, endpoint, body, bearerCode, timeout = 8000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(endpoint, baseUrl); } catch { return resolve(null); }
    if (url.protocol !== "https:") return resolve(null);

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
      rejectUnauthorized: false,
      checkServerIdentity: (_h, cert) => {
        if (!cert || !cert.pubkey) return new Error("no pubkey");
        const fpr = crypto.createHash("sha256").update(cert.pubkey).digest("base64");
        if (fpr !== SPKI_PIN) return new Error("SPKI pin mismatch");
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

async function doHeartbeat() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8"));
  } catch { return; }

  const { mac, servers, code } = config;
  if (!mac || !Array.isArray(servers) || !code) return;

  for (const server of servers) {
    const resp = await httpsPost(server, "/api/heartbeat", { mac }, code);
    if (resp === null) continue;           // network / TLS — try next server
    if (resp.ok && resp.body?.ok) return;  // happy path
    // 404 or any non-ok: explicit refusal → license no longer valid
    fs.writeFileSync(KILL_FLAG, `License refused (HTTP ${resp.status || "?"})`);
    return;
  }
  // all servers unreachable → stay quiet, try again next tick
}

doHeartbeat();
setInterval(doHeartbeat, 60 * 60 * 1000);
