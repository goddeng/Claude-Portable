#!/usr/bin/env node
/**
 * Heartbeat daemon - runs in background, checks license every 60 minutes.
 * If license invalid, writes a flag file that the launcher checks.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const DATA_DIR = process.env.CLAUDE_PORTABLE_DATA || path.join(__dirname, "..", "data");
const HEARTBEAT_FILE = path.join(DATA_DIR, ".heartbeat.json");
const KILL_FLAG = path.join(DATA_DIR, ".license_expired");

// Remove any stale kill flag
try { fs.unlinkSync(KILL_FLAG); } catch {}

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
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error("Bad JSON")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

async function doHeartbeat() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8"));
  } catch {
    return; // No config yet
  }

  const { mac, servers } = config;
  let success = false;

  for (const server of servers) {
    try {
      const result = await httpPost(server, "/api/heartbeat", { mac });
      if (result.ok) {
        success = true;
        break;
      }
      // Server reachable but license invalid
      if (!result.ok && (result.error?.includes("expired") || result.error?.includes("revoked"))) {
        fs.writeFileSync(KILL_FLAG, result.error || "License expired");
        return;
      }
    } catch {
      continue;
    }
  }

  // If all servers unreachable, allow continued use (grace period)
  // The kill flag is only written on explicit rejection
}

// Run immediately, then every 60 minutes
doHeartbeat();
setInterval(doHeartbeat, 60 * 60 * 1000);
