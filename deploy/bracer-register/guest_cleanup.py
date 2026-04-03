#!/usr/bin/env python3
"""
Guest chat session cleanup — run via cron every 10 minutes.

Finds guest sessions inactive for over 72 hours, then:
  1. Deletes the private group (room)
  2. Deactivates the guest RC account
  3. Removes the session from the database

Crontab:
    */10 * * * * . /opt/bracer-register/.token-env && op run --env-file=/opt/bracer-register/.env.op -- /opt/bracer-register/venv/bin/python /opt/bracer-register/guest_cleanup.py

Environment variables (same as bracer-register.service):
    RC_URL             — default http://localhost:3000
    RC_ADMIN_TOKEN     — required
    RC_ADMIN_USER_ID   — required
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

RC_URL = os.environ.get("RC_URL", "http://localhost:3000")
RC_ADMIN_TOKEN = os.environ.get("RC_ADMIN_TOKEN", "")
RC_ADMIN_USER_ID = os.environ.get("RC_ADMIN_USER_ID", "")
GUEST_DB = "/opt/bracer-register/guest_sessions.db"
INACTIVITY_SECONDS = 72 * 60 * 60  # 72 hours


def admin_headers():
    return {
        "X-Auth-Token": RC_ADMIN_TOKEN,
        "X-User-Id": RC_ADMIN_USER_ID,
        "Content-Type": "application/json",
    }


def get_stale_sessions():
    """Return list of (username, room_id) for sessions inactive > 72 hours."""
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


def remove_session(username):
    """Remove a session from the database."""
    db = sqlite3.connect(GUEST_DB)
    db.execute("DELETE FROM guest_sessions WHERE user_id = ?", (username,))
    db.commit()
    db.close()


def main():
    if not RC_ADMIN_TOKEN or not RC_ADMIN_USER_ID:
        logger.error("RC_ADMIN_TOKEN or RC_ADMIN_USER_ID not set")
        sys.exit(1)

    stale = get_stale_sessions()
    if not stale:
        logger.info("No stale guest sessions")
        return

    logger.info("Found %d stale guest session(s) to clean up", len(stale))

    with httpx.Client(timeout=30.0) as client:
        for username, room_id in stale:
            logger.info("Cleaning up: user=%s room=%s", username, room_id)

            # 1. Delete the private group
            try:
                resp = client.post(
                    f"{RC_URL}/api/v1/groups.delete",
                    headers=admin_headers(),
                    json={"roomId": room_id},
                )
                if resp.status_code == 200 and resp.json().get("success"):
                    logger.info("Group %s deleted", room_id)
                else:
                    logger.warning(
                        "Group deletion returned %d: %s",
                        resp.status_code, resp.text[:200],
                    )
            except Exception as e:
                logger.error("Failed to delete group %s: %s", room_id, e)

            # 2. Look up and deactivate the guest user
            try:
                resp = client.get(
                    f"{RC_URL}/api/v1/users.info",
                    headers=admin_headers(),
                    params={"username": username},
                )
                if resp.status_code == 200 and resp.json().get("success"):
                    user_id = resp.json()["user"]["_id"]
                    resp = client.post(
                        f"{RC_URL}/api/v1/users.update",
                        headers=admin_headers(),
                        json={"userId": user_id, "data": {"active": False}},
                    )
                    if resp.status_code == 200:
                        logger.info("Deactivated user %s", username)
                    else:
                        logger.warning(
                            "User deactivation returned %d: %s",
                            resp.status_code, resp.text[:200],
                        )
                else:
                    logger.warning("User %s not found for deactivation", username)
            except Exception as e:
                logger.error("Failed to deactivate %s: %s", username, e)

            # 3. Remove from tracking DB
            remove_session(username)
            logger.info("Cleanup complete for %s", username)

    logger.info("Guest cleanup finished: %d session(s) removed", len(stale))


if __name__ == "__main__":
    main()
