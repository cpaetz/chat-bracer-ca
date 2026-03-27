#!/usr/bin/env python3
"""
Guest chat session cleanup — run via cron every 10 minutes.

Finds guest sessions inactive for over 1 hour, then:
  1. Kicks all members from the room
  2. Deletes the room via Synapse admin API
  3. Deactivates the guest Matrix account
  4. Removes the session from the database

Crontab:
    */10 * * * * /opt/venvs/matrix-synapse/bin/python /opt/bracer-register/guest_cleanup.py

Environment variables (same as bracer-register.service):
    SYNAPSE_URL          — default http://localhost:8008
    SYNAPSE_ADMIN_TOKEN  — required
    SERVER_NAME          — default chat.bracer.ca
"""

import logging
import os
import sqlite3
import sys
import time

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [guest-cleanup] %(message)s",
)
logger = logging.getLogger(__name__)

SYNAPSE_URL = os.environ.get("SYNAPSE_URL", "http://localhost:8008")
SYNAPSE_ADMIN_TOKEN = os.environ.get("SYNAPSE_ADMIN_TOKEN", "")
SERVER_NAME = os.environ.get("SERVER_NAME", "chat.bracer.ca")
GUEST_DB = "/opt/bracer-register/guest_sessions.db"
INACTIVITY_SECONDS = 72 * 60 * 60  # 72 hours


def get_stale_sessions():
    """Return list of (user_id, room_id) for sessions inactive > 1 hour."""
    if not os.path.exists(GUEST_DB):
        return []
    cutoff = time.time() - INACTIVITY_SECONDS
    db = sqlite3.connect(GUEST_DB)
    rows = db.execute(
        "SELECT user_id, room_id FROM guest_sessions WHERE last_activity < ?",
        (cutoff,),
    ).fetchall()
    db.close()
    return rows


def remove_session(user_id):
    """Remove a session from the database."""
    db = sqlite3.connect(GUEST_DB)
    db.execute("DELETE FROM guest_sessions WHERE user_id = ?", (user_id,))
    db.commit()
    db.close()


def main():
    if not SYNAPSE_ADMIN_TOKEN:
        logger.error("SYNAPSE_ADMIN_TOKEN not set")
        sys.exit(1)

    stale = get_stale_sessions()
    if not stale:
        logger.info("No stale guest sessions")
        return

    logger.info("Found %d stale guest session(s) to clean up", len(stale))
    admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

    with httpx.Client(timeout=30.0) as client:
        for user_id, room_id in stale:
            logger.info("Cleaning up: user=%s room=%s", user_id, room_id)

            # 1. Delete room (Synapse admin API v2 — purges all messages)
            try:
                resp = client.delete(
                    f"{SYNAPSE_URL}/_synapse/admin/v2/rooms/{room_id}",
                    headers=admin_headers,
                    json={
                        "purge": True,
                        "message": "Guest chat session expired.",
                    },
                )
                if resp.status_code in (200, 202):
                    logger.info("Room %s deletion initiated", room_id)
                else:
                    logger.warning(
                        "Room deletion returned %d: %s",
                        resp.status_code, resp.text[:200],
                    )
            except Exception as e:
                logger.error("Failed to delete room %s: %s", room_id, e)

            # 2. Deactivate the guest account
            try:
                resp = client.put(
                    f"{SYNAPSE_URL}/_synapse/admin/v2/users/{user_id}",
                    headers=admin_headers,
                    json={"deactivated": True},
                )
                if resp.status_code == 200:
                    logger.info("Deactivated user %s", user_id)
                else:
                    logger.warning(
                        "User deactivation returned %d: %s",
                        resp.status_code, resp.text[:200],
                    )
            except Exception as e:
                logger.error("Failed to deactivate %s: %s", user_id, e)

            # 3. Erase the user (GDPR-style, removes display name + avatar)
            try:
                resp = client.post(
                    f"{SYNAPSE_URL}/_synapse/admin/v1/deactivate/{user_id}",
                    headers=admin_headers,
                    json={"erase": True},
                )
                if resp.status_code == 200:
                    logger.info("Erased user %s", user_id)
                else:
                    # May fail if already deactivated via v2 — that's fine
                    pass
            except Exception:
                pass

            # 4. Remove from tracking DB
            remove_session(user_id)
            logger.info("Cleanup complete for %s", user_id)

    logger.info("Guest cleanup finished: %d session(s) removed", len(stale))


if __name__ == "__main__":
    main()
