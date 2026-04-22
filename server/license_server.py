#!/usr/bin/env python3
"""
Claude Code Portable - License Server (v1.0.5+)

Security model:
- HTTPS only (self-signed cert + client SPKI pinning)
- All endpoints except /api/activate require Authorization: Bearer <code>
- Any unauthenticated / unknown request returns a generic 404 (no app fingerprint)
- Credential encryption key is derived per-user from sha256(code + mac); no global
  symmetric secret. Old clients (v1.0.2~v1.0.4) are therefore protocol-incompatible.
- Per-IP rate limit on activation attempts to blunt scanning / brute force.
"""

import base64
import hashlib
import json
import os
import random
import secrets
import sqlite3
import string
import threading
import time
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, Response, abort, g, jsonify, request

app = Flask(__name__)

# --- Config ---
DB_PATH = os.environ.get("LICENSE_DB", "/root/projects/usb-claude/server/license.db")
CLAUDE_CREDS = os.path.expanduser("~/.claude/.credentials.json")
CLAUDE_STATE = os.path.expanduser("~/.claude.json")
SS_CONFIG = "/root/projects/usb-claude/configs/ss-config.json"
TLS_CERT = os.environ.get("TLS_CERT", "/root/projects/usb-claude/server/tls/cert.pem")
TLS_KEY = os.environ.get("TLS_KEY", "/root/projects/usb-claude/server/tls/key.pem")
LISTEN_HOST = os.environ.get("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "9099"))
MIN_AVAILABLE_CODES = 20
DEFAULT_EXPIRY_DAYS = 30

# Rate limits (per IP, per minute)
ACTIVATE_LIMIT = 10   # /api/activate — keep generous for legit users
OTHER_LIMIT = 60      # authenticated endpoints


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
    auto_generate_codes(db)
    db.close()


# =============================================================================
# Code generation
# =============================================================================
def generate_code():
    chars = string.ascii_letters + string.digits
    timestamp = str(int(time.time()))
    random_part = "".join(secrets.choice(chars) for _ in range(32 - len(timestamp)))
    raw = random_part + timestamp
    raw_list = list(raw)
    random.shuffle(raw_list)
    display_code = "".join(raw_list)[:32]
    code_hash = hashlib.sha256(display_code.encode()).hexdigest()
    return display_code, code_hash


def auto_generate_codes(db=None):
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
# Encryption — per-user key derived from code+mac. No global secret.
# =============================================================================
def derive_key(code: str, mac: str) -> bytes:
    return hashlib.sha256(f"{code}:{mac}".encode()).digest()


def xor_bytes(data: bytes, key_bytes: bytes) -> bytes:
    return bytes(b ^ key_bytes[i % len(key_bytes)] for i, b in enumerate(data))


def encrypt_payload(data: dict, code: str, mac: str) -> str:
    key = derive_key(code, mac)
    raw = json.dumps(data).encode()
    return base64.b64encode(xor_bytes(raw, key)).decode()


# =============================================================================
# Rate limit (in-memory, 60s sliding window per IP+bucket)
# =============================================================================
_rate_buckets: dict = {}
_rate_lock = threading.Lock()


def check_rate(bucket_name: str, limit: int) -> bool:
    """True if under limit, False if over."""
    ip = request.remote_addr or "unknown"
    key = (ip, bucket_name)
    now = time.time()
    with _rate_lock:
        times = _rate_buckets.get(key, [])
        times = [t for t in times if now - t < 60]
        if len(times) >= limit:
            _rate_buckets[key] = times
            return False
        times.append(now)
        _rate_buckets[key] = times
    return True


# =============================================================================
# Helpers
# =============================================================================
def validate_mac(mac):
    if not mac or len(mac) < 12:
        return False
    clean = mac.replace(":", "").replace("-", "").lower()
    return len(clean) == 12 and all(c in "0123456789abcdef" for c in clean)


def normalize_mac(mac):
    return mac.replace(":", "").replace("-", "").lower()


def get_bearer_code() -> str | None:
    """Extract activation code from Authorization: Bearer <code>."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    code = auth[7:].strip()
    return code if code else None


def not_found():
    """Uniform 404 — no hints, no app fingerprint."""
    return Response("404 Not Found", status=404, mimetype="text/plain")


def require_code(f):
    """
    Decorator: the request must carry Authorization: Bearer <valid code>,
    the code must be un-revoked and un-expired, and — if the body has 'mac' —
    the code must be bound to that mac. Else: 404 (don't reveal failure reason).
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not check_rate("auth", OTHER_LIMIT):
            return not_found()

        code = get_bearer_code()
        if not code:
            return not_found()

        code_hash = hashlib.sha256(code.encode()).hexdigest()
        db = get_db()
        code_row = db.execute(
            "SELECT * FROM codes WHERE code_hash = ? AND revoked = 0",
            (code_hash,),
        ).fetchone()
        if not code_row:
            return not_found()
        if code_row["expires_at"] and code_row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
            return not_found()

        # Optional MAC binding enforcement
        body = request.get_json(silent=True) or {}
        body_mac = body.get("mac", "")
        if body_mac:
            if not validate_mac(body_mac):
                return not_found()
            nm = normalize_mac(body_mac)
            if code_row["used_by_mac"] and code_row["used_by_mac"] != nm:
                return not_found()

        g.current_code = code
        g.current_code_row = code_row
        return f(*args, **kwargs)
    return wrapper


# =============================================================================
# API Endpoints
# =============================================================================
@app.route("/api/activate", methods=["POST"])
def activate():
    """
    Activate a device. Body: {"mac": "...", "code": "..."}.
    No Authorization header needed — the code itself is the credential.
    Rate-limited per IP to blunt brute force.
    """
    if not check_rate("activate", ACTIVATE_LIMIT):
        return not_found()

    data = request.get_json(silent=True) or {}
    mac = data.get("mac", "")
    code = data.get("code", "")

    if not validate_mac(mac):
        return not_found()
    if not code:
        return not_found()

    mac = normalize_mac(mac)
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    db = get_db()

    code_row = db.execute(
        "SELECT * FROM codes WHERE code_hash = ? AND revoked = 0",
        (code_hash,),
    ).fetchone()
    if not code_row:
        return not_found()
    if code_row["expires_at"] and code_row["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
        return not_found()
    if code_row["used_by_mac"] and code_row["used_by_mac"] != mac:
        return not_found()

    # Bind (idempotent if already bound to same mac)
    db.execute(
        "UPDATE codes SET used_at = COALESCE(used_at, datetime('now')), used_by_mac = ? WHERE code_hash = ?",
        (mac, code_hash),
    )
    db.execute(
        "INSERT OR REPLACE INTO activations (code_hash, mac_address, is_internal, client_ip) VALUES (?, ?, 0, ?)",
        (code_hash, mac, request.remote_addr),
    )
    db.commit()

    auto_generate_codes(db)

    return jsonify({
        "ok": True,
        "expires_at": code_row["expires_at"],
    })


@app.route("/api/heartbeat", methods=["POST"])
@require_code
def heartbeat():
    """Heartbeat. Requires Bearer token + mac. Returns basic liveness."""
    data = request.get_json(silent=True) or {}
    mac = normalize_mac(data.get("mac", ""))
    if not mac:
        return not_found()

    db = get_db()
    activation = db.execute(
        "SELECT * FROM activations WHERE mac_address = ?", (mac,)
    ).fetchone()
    if not activation:
        return not_found()
    if activation["code_hash"] != g.current_code_row["code_hash"]:
        return not_found()

    db.execute(
        "UPDATE activations SET last_heartbeat = datetime('now'), client_ip = ? WHERE mac_address = ?",
        (request.remote_addr, mac),
    )
    db.commit()
    return jsonify({"ok": True, "expires_at": g.current_code_row["expires_at"]})


@app.route("/api/credentials", methods=["POST"])
@require_code
def credentials():
    """Return per-user encrypted credentials + SS config."""
    data = request.get_json(silent=True) or {}
    mac = normalize_mac(data.get("mac", ""))
    if not mac:
        return not_found()

    db = get_db()
    activation = db.execute(
        "SELECT * FROM activations WHERE mac_address = ?", (mac,)
    ).fetchone()
    if not activation or activation["code_hash"] != g.current_code_row["code_hash"]:
        return not_found()

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
                acct["emailAddress"] = "Portable Claude"
                acct["organizationName"] = "Portable Claude"
                payload["state"]["oauthAccount"] = acct

    if os.path.exists(SS_CONFIG):
        with open(SS_CONFIG) as f:
            payload["ss_config"] = json.load(f)

    encrypted = encrypt_payload(payload, g.current_code, mac)
    return jsonify({"ok": True, "data": encrypted})


# =============================================================================
# Catch-all: anything not explicitly mapped is a 404. No app fingerprint.
# =============================================================================
@app.errorhandler(404)
def _handle_404(_e):
    return not_found()


@app.errorhandler(405)
def _handle_405(_e):
    # Pretend wrong methods also don't exist
    return not_found()


@app.errorhandler(Exception)
def _handle_exc(e):
    app.logger.exception("unhandled: %s", e)
    return not_found()


# =============================================================================
# Main
# =============================================================================
if __name__ == "__main__":
    init_db()

    if not (os.path.exists(TLS_CERT) and os.path.exists(TLS_KEY)):
        raise SystemExit(
            f"[LICENSE] TLS cert/key missing: {TLS_CERT} / {TLS_KEY}\n"
            f"Generate with:\n"
            f"  openssl req -x509 -newkey rsa:4096 -keyout {TLS_KEY} "
            f"-out {TLS_CERT} -days 3650 -nodes -subj '/CN=claude-portable-license'"
        )

    print(f"[LICENSE] Database: {DB_PATH}")
    print(f"[LICENSE] TLS cert: {TLS_CERT}")
    print(f"[LICENSE] HTTPS  on {LISTEN_HOST}:{LISTEN_PORT}")
    app.run(host=LISTEN_HOST, port=LISTEN_PORT,
            ssl_context=(TLS_CERT, TLS_KEY), debug=False)
