#!/usr/bin/env python3
"""
Claude Code Portable - Admin CLI
Manage activation codes and view activations.
"""

import argparse
import hashlib
import sqlite3
import sys
from datetime import datetime, timedelta

DB_PATH = "/root/projects/usb-claude/server/license.db"


def get_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def cmd_list_codes(args):
    """List activation codes."""
    db = get_db()
    if args.all:
        rows = db.execute("SELECT * FROM codes ORDER BY created_at DESC").fetchall()
    elif args.used:
        rows = db.execute("SELECT * FROM codes WHERE used_at IS NOT NULL ORDER BY used_at DESC").fetchall()
    else:
        # Available only
        rows = db.execute("""
            SELECT * FROM codes
            WHERE used_at IS NULL AND revoked = 0
            AND (expires_at IS NULL OR expires_at > datetime('now'))
            ORDER BY created_at DESC
        """).fetchall()

    if not rows:
        print("No codes found.")
        return

    print(f"{'Code':<34} {'Status':<10} {'Expires':<20} {'MAC':<14} {'Note'}")
    print("-" * 110)
    for r in rows:
        status = "REVOKED" if r["revoked"] else ("USED" if r["used_at"] else "AVAILABLE")
        if not r["revoked"] and not r["used_at"] and r["expires_at"]:
            if r["expires_at"] < datetime.now().strftime("%Y-%m-%d %H:%M:%S"):
                status = "EXPIRED"
        mac = r["used_by_mac"] or ""
        expires = r["expires_at"] or "NEVER"
        note = r["note"] or ""
        # Show code only for available ones, mask for used
        code = r["code"] if status == "AVAILABLE" else r["code"][:8] + "..." + r["code"][-4:]
        print(f"{code:<34} {status:<10} {expires:<20} {mac:<14} {note}")

    print(f"\nTotal: {len(rows)}")


def cmd_set_expiry(args):
    """Set expiration for a code or all available codes."""
    db = get_db()

    if args.days:
        expires = (datetime.now() + timedelta(days=args.days)).strftime("%Y-%m-%d %H:%M:%S")
    elif args.date:
        expires = args.date
    else:
        print("Error: specify --days or --date")
        return

    if args.code:
        code_hash = hashlib.sha256(args.code.encode()).hexdigest()
        db.execute("UPDATE codes SET expires_at = ? WHERE code_hash = ?", (expires, code_hash))
        affected = db.execute("SELECT changes()").fetchone()[0]
    elif args.all_available:
        db.execute("""
            UPDATE codes SET expires_at = ?
            WHERE used_at IS NULL AND revoked = 0
        """, (expires,))
        affected = db.execute("SELECT changes()").fetchone()[0]
    else:
        print("Error: specify --code or --all-available")
        return

    db.commit()
    print(f"Updated {affected} code(s), expires: {expires}")


def cmd_revoke(args):
    """Revoke a code and its activation."""
    db = get_db()

    if args.code:
        code_hash = hashlib.sha256(args.code.encode()).hexdigest()
        db.execute(
            "UPDATE codes SET revoked = 1, used_by_mac = NULL, used_at = NULL WHERE code_hash = ?",
            (code_hash,),
        )
        db.execute("DELETE FROM activations WHERE code_hash = ?", (code_hash,))
    elif args.mac:
        mac = args.mac.replace(":", "").replace("-", "").lower()
        activation = db.execute("SELECT code_hash FROM activations WHERE mac_address = ?", (mac,)).fetchone()
        if activation:
            db.execute(
                "UPDATE codes SET revoked = 1, used_by_mac = NULL, used_at = NULL WHERE code_hash = ?",
                (activation["code_hash"],),
            )
        db.execute("DELETE FROM activations WHERE mac_address = ?", (mac,))
    else:
        print("Error: specify --code or --mac")
        return

    db.commit()
    print("Revoked.")


def cmd_activations(args):
    """List active devices."""
    db = get_db()
    rows = db.execute("""
        SELECT a.*, c.code, c.expires_at, c.revoked
        FROM activations a
        LEFT JOIN codes c ON a.code_hash = c.code_hash
        ORDER BY a.last_heartbeat DESC
    """).fetchall()

    if not rows:
        print("No active devices.")
        return

    print(f"{'MAC':<14} {'Internal':<10} {'Last Heartbeat':<20} {'Expires':<20} {'IP':<16} {'Code'}")
    print("-" * 110)
    for r in rows:
        internal = "YES" if r["is_internal"] else "NO"
        code = r["code"][:8] + "..." if r["code"] else "N/A"
        expires = r["expires_at"] or "NEVER"
        print(f"{r['mac_address']:<14} {internal:<10} {r['last_heartbeat']:<20} {expires:<20} {r['client_ip'] or '':<16} {code}")

    print(f"\nTotal: {len(rows)} device(s)")


def cmd_generate(args):
    """Manually generate codes."""
    from license_server import generate_code

    db = get_db()
    count = args.count

    if args.permanent:
        expires = None
        expires_label = "permanent"
    else:
        days = args.days or 30
        expires = (datetime.now() + timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        expires_label = expires

    generated = []
    for _ in range(count):
        code, code_hash = generate_code()
        try:
            db.execute(
                "INSERT INTO codes (code, code_hash, expires_at, note) VALUES (?, ?, ?, ?)",
                (code, code_hash, expires, args.note or ""),
            )
            generated.append(code)
        except sqlite3.IntegrityError:
            continue

    db.commit()
    print(f"Generated {len(generated)} codes (expires: {expires_label}):\n")
    for c in generated:
        print(f"  {c}")


def cmd_note(args):
    """Set note on a code."""
    db = get_db()
    code_hash = hashlib.sha256(args.code.encode()).hexdigest()
    db.execute("UPDATE codes SET note = ? WHERE code_hash = ?", (args.text, code_hash))
    affected = db.execute("SELECT changes()").fetchone()[0]
    db.commit()
    if affected:
        print(f"Note set: {args.text}")
    else:
        print("Code not found.")


def cmd_stats(args):
    """Show statistics."""
    db = get_db()
    total = db.execute("SELECT COUNT(*) FROM codes").fetchone()[0]
    available = db.execute("""
        SELECT COUNT(*) FROM codes
        WHERE used_at IS NULL AND revoked = 0
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    """).fetchone()[0]
    used = db.execute("SELECT COUNT(*) FROM codes WHERE used_at IS NOT NULL AND revoked = 0").fetchone()[0]
    revoked = db.execute("SELECT COUNT(*) FROM codes WHERE revoked = 1").fetchone()[0]
    expired = db.execute("""
        SELECT COUNT(*) FROM codes
        WHERE revoked = 0 AND used_at IS NULL
        AND expires_at IS NOT NULL AND expires_at <= datetime('now')
    """).fetchone()[0]
    devices = db.execute("SELECT COUNT(*) FROM activations").fetchone()[0]

    print(f"Codes:   {total} total | {available} available | {used} used | {expired} expired | {revoked} revoked")
    print(f"Devices: {devices} activated")


def main():
    parser = argparse.ArgumentParser(description="Claude Portable License Admin")
    sub = parser.add_subparsers(dest="command")

    # list
    p = sub.add_parser("list", help="List codes")
    p.add_argument("--all", action="store_true", help="Show all codes")
    p.add_argument("--used", action="store_true", help="Show used codes only")

    # expiry
    p = sub.add_parser("expiry", help="Set code expiration")
    p.add_argument("--code", help="Specific code")
    p.add_argument("--all-available", action="store_true", help="All available codes")
    p.add_argument("--days", type=int, help="Days from now")
    p.add_argument("--date", help="Exact date (YYYY-MM-DD HH:MM:SS)")

    # revoke
    p = sub.add_parser("revoke", help="Revoke a code or device")
    p.add_argument("--code", help="Code to revoke")
    p.add_argument("--mac", help="MAC to revoke")

    # activations
    sub.add_parser("devices", help="List activated devices")

    # generate
    p = sub.add_parser("generate", help="Generate codes manually")
    p.add_argument("--count", type=int, default=10, help="Number of codes")
    p.add_argument("--days", type=int, default=30, help="Expiry in days (ignored if --permanent)")
    p.add_argument("--permanent", action="store_true", help="Generate permanent codes (no expiry)")
    p.add_argument("--note", help="Note for the codes")

    # note
    p = sub.add_parser("note", help="Set note on a code")
    p.add_argument("code", help="The activation code")
    p.add_argument("text", help="Note text")

    # stats
    sub.add_parser("stats", help="Show statistics")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    commands = {
        "list": cmd_list_codes,
        "expiry": cmd_set_expiry,
        "revoke": cmd_revoke,
        "devices": cmd_activations,
        "generate": cmd_generate,
        "note": cmd_note,
        "stats": cmd_stats,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
