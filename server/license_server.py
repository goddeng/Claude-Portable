#!/usr/bin/env python3
"""
Claude Code Portable - License Server
Manages activation codes, MAC binding, and credential distribution.
"""

import hashlib
import json
import os
import random
import secrets
import sqlite3
import string
import time
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, request

app = Flask(__name__)

# --- Config ---
DB_PATH = os.environ.get("LICENSE_DB", "/root/projects/usb-claude/server/license.db")
CLAUDE_CREDS = os.path.expanduser("~/.claude/.credentials.json")
CLAUDE_STATE = os.path.expanduser("~/.claude.json")
SS_CONFIG = "/root/projects/usb-claude/configs/ss-config.json"
ENCRYPT_KEY = os.environ.get("ENCRYPT_KEY", "change-me-before-deploy")
MIN_AVAILABLE_CODES = 20
DEFAULT_EXPIRY_DAYS = 30
HEARTBEAT_INTERVAL = 3600  # 60 minutes
HEARTBEAT_GRACE = 300  # 5 min grace period
# Internal network prefixes - clients from these IPs skip code verification
INTERNAL_PREFIXES = os.environ.get("INTERNAL_PREFIXES", "192.168.,10.,127.0.0.1").split(",")


# =============================================================================
# Database
# =============================================================================
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("""
        CREATE TABLE IF NOT EXISTS codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            code_hash TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT,
            used_at TEXT,
            used_by_mac TEXT,
            revoked INTEGER NOT NULL DEFAULT 0,
            note TEXT
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS activations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code_hash TEXT NOT NULL,
            mac_address TEXT NOT NULL,
            activated_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
            is_internal INTEGER NOT NULL DEFAULT 0,
            client_ip TEXT,
            UNIQUE(mac_address)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_codes_hash ON codes(code_hash)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_activations_mac ON activations(mac_address)")
    db.commit()

    # Auto-generate codes if needed
    auto_generate_codes(db)
    db.close()


# =============================================================================
# Code generation
# =============================================================================
def generate_code():
    """Generate a 32-char random string, return (display_code, hash)."""
    chars = string.ascii_letters + string.digits
    timestamp = str(int(time.time()))
    random_part = "".join(secrets.choice(chars) for _ in range(32 - len(timestamp)))
    raw = random_part + timestamp
    # Shuffle to mix timestamp into random chars
    raw_list = list(raw)
    random.shuffle(raw_list)
    display_code = "".join(raw_list)[:32]
    code_hash = hashlib.sha256(display_code.encode()).hexdigest()
    return display_code, code_hash


def auto_generate_codes(db=None):
    """If available codes < MIN_AVAILABLE_CODES, generate more."""
    close_after = False
    if db is None:
        db = sqlite3.connect(DB_PATH)
        close_after = True

    row = db.execute("""
        SELECT COUNT(*) as cnt FROM codes
        WHERE used_at IS NULL AND revoked = 0
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    """).fetchone()
    available = row[0] if row else 0

    if available < MIN_AVAILABLE_CODES:
        need = MIN_AVAILABLE_CODES - available
        default_expiry = (datetime.now() + timedelta(days=DEFAULT_EXPIRY_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
        for _ in range(need):
            code, code_hash = generate_code()
            try:
                db.execute(
                    "INSERT INTO codes (code, code_hash, expires_at) VALUES (?, ?, ?)",
                    (code, code_hash, default_expiry),
                )
            except sqlite3.IntegrityError:
                continue
        db.commit()
        print(f"[LICENSE] Auto-generated {need} new codes (available was {available})")

    if close_after:
        db.close()


# =============================================================================
# Encryption helpers
# =============================================================================
def xor_encrypt(data: bytes, key: str) -> bytes:
    key_bytes = hashlib.sha256(key.encode()).digest()
    return bytes(b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(data))


def encrypt_payload(data: dict, mac: str) -> str:
    """Encrypt JSON payload with ENCRYPT_KEY + MAC as combined key."""
    combined_key = f"{ENCRYPT_KEY}:{mac}"
    raw = json.dumps(data).encode()
    encrypted = xor_encrypt(raw, combined_key)
    import base64
    return base64.b64encode(encrypted).decode()


# =============================================================================
# Helpers
# =============================================================================
def is_internal(ip):
    return any(ip.startswith(p) for p in INTERNAL_PREFIXES)


def get_client_ip():
    return request.headers.get("X-Forwarded-For", request.remote_addr).split(",")[0].strip()


def validate_mac(mac):
    """Basic MAC address format validation."""
    if not mac or len(mac) < 12:
        return False
    clean = mac.replace(":", "").replace("-", "").lower()
    return len(clean) == 12 and all(c in "0123456789abcdef" for c in clean)


def normalize_mac(mac):
    return mac.replace(":", "").replace("-", "").lower()


# =============================================================================
# API Endpoints
# =============================================================================
@app.route("/api/activate", methods=["POST"])
def activate():
    """
    Activate a device.
    Body: {"mac": "AA:BB:CC:DD:EE:FF", "code": "xxx"} or {"mac": "...", "internal": true}
    """
    data = request.get_json(force=True) or {}
    mac = data.get("mac", "")
    code = data.get("code", "")
    client_ip = get_client_ip()
    internal = is_internal(client_ip)

    if not validate_mac(mac):
        return jsonify({"ok": False, "error": "Invalid MAC address"}), 400

    mac = normalize_mac(mac)
    db = get_db()

    # Check if already activated
    existing = db.execute("SELECT * FROM activations WHERE mac_address = ?", (mac,)).fetchone()
    if existing:
        # Check if the bound code is still valid
        code_row = db.execute(
            "SELECT * FROM codes WHERE code_hash = ? AND revoked = 0", (existing["code_hash"],)
        ).fetchone()
        if code_row and (not code_row["expires_at"] or code_row["expires_at"] > datetime.now().strftime("%Y-%m-%d %H:%M:%S")):
            # Update heartbeat
            db.execute("UPDATE activations SET last_heartbeat = datetime('now'), client_ip = ? WHERE mac_address = ?", (client_ip, mac))
            db.commit()
            return jsonify({"ok": True, "message": "Already activated", "expires_at": code_row["expires_at"]})
        else:
            # Code expired or revoked, remove old activation
            db.execute("DELETE FROM activations WHERE mac_address = ?", (mac,))
            db.commit()

    # Internal network: auto-activate with a reserved code
    if internal:
        # Find or create an internal activation code
        internal_code_hash = hashlib.sha256(f"internal:{mac}".encode()).hexdigest()
        row = db.execute("SELECT * FROM codes WHERE code_hash = ?", (internal_code_hash,)).fetchone()
        if not row:
            db.execute(
                "INSERT OR IGNORE INTO codes (code, code_hash, expires_at, note) VALUES (?, ?, ?, ?)",
                (f"INTERNAL-{mac}", internal_code_hash, None, "Auto-generated for internal network"),
            )
        db.execute(
            "INSERT OR REPLACE INTO activations (code_hash, mac_address, is_internal, client_ip) VALUES (?, ?, 1, ?)",
            (internal_code_hash, mac, client_ip),
        )
        db.commit()
        return jsonify({"ok": True, "message": "Internal network activated", "expires_at": None})

    # External: require code
    if not code:
        return jsonify({"ok": False, "error": "Activation code required", "need_code": True}), 403

    code_hash = hashlib.sha256(code.encode()).hexdigest()
    code_row = db.execute(
        "SELECT * FROM codes WHERE code_hash = ? AND revoked = 0", (code_hash,)
    ).fetchone()

    if not code_row:
        return jsonify({"ok": False, "error": "Invalid activation code"}), 403

    if code_row["expires_at"] and code_row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        return jsonify({"ok": False, "error": "Activation code expired"}), 403

    if code_row["used_by_mac"] and code_row["used_by_mac"] != mac:
        return jsonify({"ok": False, "error": "Code already used by another device"}), 403

    # Bind code to MAC
    db.execute("UPDATE codes SET used_at = datetime('now'), used_by_mac = ? WHERE code_hash = ?", (mac, code_hash))
    db.execute(
        "INSERT OR REPLACE INTO activations (code_hash, mac_address, is_internal, client_ip) VALUES (?, ?, 0, ?)",
        (code_hash, mac, client_ip),
    )
    db.commit()

    # Auto-generate if needed
    auto_generate_codes(db)

    return jsonify({"ok": True, "message": "Activated successfully", "expires_at": code_row["expires_at"]})


@app.route("/api/heartbeat", methods=["POST"])
def heartbeat():
    """
    Heartbeat check. Client sends every 60 minutes.
    Body: {"mac": "AA:BB:CC:DD:EE:FF"}
    """
    data = request.get_json(force=True) or {}
    mac = normalize_mac(data.get("mac", ""))

    if not mac:
        return jsonify({"ok": False, "error": "MAC required"}), 400

    db = get_db()
    activation = db.execute("SELECT * FROM activations WHERE mac_address = ?", (mac,)).fetchone()

    if not activation:
        return jsonify({"ok": False, "error": "Not activated", "need_activate": True}), 403

    # Check code validity
    code_row = db.execute(
        "SELECT * FROM codes WHERE code_hash = ? AND revoked = 0", (activation["code_hash"],)
    ).fetchone()

    if not code_row:
        db.execute("DELETE FROM activations WHERE mac_address = ?", (mac,))
        db.commit()
        return jsonify({"ok": False, "error": "License revoked"}), 403

    if code_row["expires_at"] and code_row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        return jsonify({"ok": False, "error": "License expired", "expired_at": code_row["expires_at"]}), 403

    # Update heartbeat
    db.execute(
        "UPDATE activations SET last_heartbeat = datetime('now'), client_ip = ? WHERE mac_address = ?",
        (get_client_ip(), mac),
    )
    db.commit()

    return jsonify({"ok": True, "expires_at": code_row["expires_at"]})


@app.route("/api/credentials", methods=["POST"])
def credentials():
    """
    Return encrypted credentials + SS config.
    Only for activated devices. Encrypted with device MAC.
    Body: {"mac": "AA:BB:CC:DD:EE:FF"}
    """
    data = request.get_json(force=True) or {}
    mac = normalize_mac(data.get("mac", ""))

    if not mac:
        return jsonify({"ok": False, "error": "MAC required"}), 400

    db = get_db()
    activation = db.execute("SELECT * FROM activations WHERE mac_address = ?", (mac,)).fetchone()

    if not activation:
        return jsonify({"ok": False, "error": "Not activated"}), 403

    # Verify code still valid
    code_row = db.execute(
        "SELECT * FROM codes WHERE code_hash = ? AND revoked = 0", (activation["code_hash"],)
    ).fetchone()

    if not code_row:
        return jsonify({"ok": False, "error": "License revoked"}), 403

    if code_row["expires_at"] and code_row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        return jsonify({"ok": False, "error": "License expired"}), 403

    # Load and encrypt credentials
    payload = {}

    if os.path.exists(CLAUDE_CREDS):
        with open(CLAUDE_CREDS) as f:
            payload["credentials"] = json.load(f)

    if os.path.exists(CLAUDE_STATE):
        with open(CLAUDE_STATE) as f:
            full_state = json.load(f)
            payload["state"] = {
                "hasCompletedOnboarding": True,
                "numStartups": 1,
                "installMethod": "global",
            }
            if "oauthAccount" in full_state:
                acct = {k: v for k, v in full_state["oauthAccount"].items()
                        if k not in ("displayName",)}
                # Replace personal info with branded name
                acct["emailAddress"] = "Portable Claude"
                acct["organizationName"] = "Portable Claude"
                payload["state"]["oauthAccount"] = acct

    if os.path.exists(SS_CONFIG):
        with open(SS_CONFIG) as f:
            payload["ss_config"] = json.load(f)

    encrypted = encrypt_payload(payload, mac)
    return jsonify({"ok": True, "data": encrypted})


# =============================================================================
# Health check
# =============================================================================
@app.route("/api/health")
def health():
    return jsonify({"ok": True, "time": datetime.now().isoformat()})


# =============================================================================
# Main
# =============================================================================
if __name__ == "__main__":
    init_db()
    print(f"[LICENSE] Database: {DB_PATH}")
    print(f"[LICENSE] Server starting on 0.0.0.0:9099")
    app.run(host="0.0.0.0", port=9099, debug=False)
