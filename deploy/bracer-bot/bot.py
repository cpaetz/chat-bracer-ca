#!/usr/bin/env python3
"""
bracer-bot — Bracer Systems support bot for Rocket.Chat.

Phase 3 of Bracer Chat v2 (RC migration).
Python + FastAPI webhook receiver, systemd service on bracer-chat-rc.

Architecture:
  RC outgoing webhook -> POST /webhook -> dispatch by message type
  Bot replies via RC REST API (chat.postMessage)

Behaviour:
  - Greets on first client message per room (business-hours-aware)
  - !ticket -> SuperOps ticket flow (3 questions + screenshot, 10-min timeout)
  - !cancel -> cancels active ticket flow (works for both clients and staff)
  - Never responds to staff or itself
  - Captures diagnostic responses from Electron app for ticket enrichment
"""

import asyncio
import html
import json
import base64
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# ── Config ─────────────────────────────────────────────────────────────────────

RC_URL              = os.environ.get("RC_URL", "http://localhost:3000")
RC_BOT_TOKEN        = os.environ["RC_BOT_TOKEN"]
RC_BOT_USER_ID      = os.environ["RC_BOT_USER_ID"]
RC_ADMIN_TOKEN      = os.environ.get("RC_ADMIN_TOKEN", "")
RC_ADMIN_USER_ID    = os.environ.get("RC_ADMIN_USER_ID", "")
RC_WEBHOOK_TOKEN    = os.environ.get("RC_WEBHOOK_TOKEN", "")
BOT_USERNAME        = os.environ.get("BOT_USERNAME", "bracerbot")
STAFF_USERNAMES     = set(filter(None, os.environ.get("STAFF_USERNAMES", "chris.paetz,teri.sauve").split(",")))
SUPEROPS_API_KEY    = os.environ["SUPEROPS_API_KEY"]
SUPEROPS_SUBDOMAIN  = os.environ.get("SUPEROPS_SUBDOMAIN", "bracer")
DB_PATH             = os.environ.get("DB_PATH", "/opt/bracer-bot/bracer_bot.db")

TIMEZONE             = ZoneInfo("America/Edmonton")
TICKET_TIMEOUT_SECS  = 600   # 10 minutes
TICKET_RATE_LIMIT    = 10    # max tickets per room per hour
INPUT_MAX_LEN        = 2000  # max chars per user input field

SUPEROPS_GQL_URL = "https://api.superops.ai/msp"
SUPEROPS_UPLOAD_URL = "https://api.superops.ai/upload"

AUTORESPONDER_CONFIG_PATH = "/opt/bracer-register/autoresponder.json"

# In-memory: tracks the timestamp of the last message in each room (any sender)
_room_last_message: dict[str, float] = {}  # room_id -> epoch seconds

# In-memory: caches machine info responses per room (populated by diagnostic reply)
_room_machine_info: dict[str, dict] = {}  # room_id -> {"user": ..., "serial": ..., "ip": ..., "mac": ...}
_room_diag_text: dict[str, list] = {}  # room_id -> list of raw diag response strings
_room_diag_events: dict[str, asyncio.Event] = {}  # room_id -> Event signalled when all 6 diag responses arrive

GREETING_BUSINESS = (
    "Hi! Thanks for reaching out to Bracer Systems Support. "
    "A technician will be with you as soon as possible. "
    "You can also type !ticket at any time to open a support ticket."
)
GREETING_AFTERHOURS = (
    "Hi! Thanks for reaching out to Bracer Systems Support. "
    "Our team is available Monday\u2013Friday, 8am\u20135pm MT. "
    "We\u2019ll get back to you when we\u2019re back. "
    "In the meantime, type !ticket to open a support ticket."
)

PRIORITY_MAP = {"1": "Low", "2": "Medium", "3": "High"}

GUEST_GREETING_BUSINESS = (
    "Hi! Thanks for reaching out to Bracer Systems Support. "
    "A technician will be with you as soon as possible."
)
GUEST_GREETING_AFTERHOURS = (
    "Hi! Thanks for reaching out to Bracer Systems Support. "
    "Our office is currently closed (Monday\u2013Friday, 8am\u20135pm MT).\n\n"
    "For after-hours emergencies, call 587-400-9573 and select the after-hours emergency option "
    "to reach a technician immediately.\n\n"
    "Otherwise, I can take a message and someone will follow up next business day. "
    "What is your name?"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
log = logging.getLogger("bracer-bot")

# ── FastAPI App ───────────────────────────────────────────────────────────────

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("startup")
async def startup():
    init_db()
    log.info(f"bracer-bot started (RC webhook mode, bot={BOT_USERNAME})")


@app.get("/health")
async def health():
    return {"status": "ok", "bot": BOT_USERNAME}


@app.post("/webhook")
async def webhook(request: Request):
    """Receive RC outgoing webhook — dispatch to message handlers."""
    payload = await request.json()

    # Validate webhook token
    token = payload.get("token", "")
    if RC_WEBHOOK_TOKEN and token != RC_WEBHOOK_TOKEN:
        return JSONResponse(status_code=401, content={"error": "invalid token"})

    # Extract fields from RC webhook payload
    user_name = payload.get("user_name", "")
    room_id = payload.get("channel_id", "")
    channel_name = payload.get("channel_name", "")
    body = (payload.get("text") or "").strip()
    is_bot = payload.get("bot", False)
    message_id = payload.get("message_id", "")

    # RC outgoing webhooks do NOT include file attachment data in the payload.
    # If the message has no text, it's likely a file upload — fetch the full
    # message via REST API to get the attachment URLs.
    attachments = payload.get("attachments") or []
    file_url = ""
    if attachments:
        for att in attachments:
            if att.get("image_url"):
                file_url = att["image_url"]
                break
            if att.get("title_link"):
                file_url = att["title_link"]
                break

    # Fallback: if no text and no attachments in webhook, fetch full message from API
    if not body and not file_url and message_id:
        try:
            full_msg = await _rc_get_message(message_id)
            if full_msg:
                for att in (full_msg.get("attachments") or []):
                    if att.get("image_url"):
                        file_url = att["image_url"]
                        break
                    if att.get("title_link"):
                        file_url = att["title_link"]
                        break
                if not body:
                    body = (full_msg.get("msg") or "").strip()
        except Exception as exc:
            log.warning(f"Failed to fetch full message {message_id}: {exc}")

    # Ignore bot messages and our own messages
    if is_bot or user_name == BOT_USERNAME:
        return {"status": "ignored"}

    # ── Autoresponder: check idle time BEFORE recording this message ──────
    is_from_customer = user_name not in STAFF_USERNAMES
    should_autorespond = is_from_customer and _should_autorespond(room_id)

    # Record activity for ALL senders
    _record_room_activity(room_id)

    # ── Diagnostic response detection (replaces on_notice) ────────────────
    if _is_diag_response(body):
        _handle_diagnostic(room_id, body)
        return {"status": "diag_captured"}

    # ── Image attachment handling (replaces on_image) ─────────────────────
    if file_url and not body:
        # Pure image message (no text)
        await _handle_image(room_id, channel_name, user_name, file_url)
        return {"status": "ok"}

    # ── Text message handling (replaces on_message) ───────────────────────
    body = _truncate(body)
    await _handle_message(room_id, channel_name, user_name, body,
                          should_autorespond, file_url)
    return {"status": "ok"}


# ── Database ───────────────────────────────────────────────────────────────────

def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS greeted_rooms (
                room_id     TEXT PRIMARY KEY,
                greeted_at  TEXT NOT NULL,
                company     TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ticket_sessions (
                room_id        TEXT PRIMARY KEY,
                state          TEXT NOT NULL,
                issue          TEXT,
                tried          TEXT,
                reproduce      TEXT,
                when_started   TEXT,
                last_activity  TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ticket_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id    TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS guest_contact_sessions (
                room_id        TEXT PRIMARY KEY,
                state          TEXT NOT NULL,
                contact_name   TEXT,
                company_name   TEXT,
                phone          TEXT,
                message        TEXT,
                preference     TEXT,
                last_activity  TEXT NOT NULL
            )
        """)
        # Migrations for existing DBs
        try:
            conn.execute("ALTER TABLE greeted_rooms ADD COLUMN company TEXT")
        except sqlite3.OperationalError:
            pass
        for col in ("tried TEXT", "reproduce TEXT", "when_started TEXT",
                     "pending_ticket_id TEXT", "screenshot_mxc TEXT",
                     "staff_triggered INTEGER DEFAULT 0", "initiating_staff TEXT"):
            try:
                conn.execute(f"ALTER TABLE ticket_sessions ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass
        for col in ("pending_ticket_id TEXT", "screenshot_mxc TEXT"):
            try:
                conn.execute(f"ALTER TABLE guest_contact_sessions ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass

    try:
        os.chmod(DB_PATH, 0o640)
    except OSError:
        pass


def has_greeted(room_id: str) -> bool:
    with _db() as conn:
        return conn.execute(
            "SELECT 1 FROM greeted_rooms WHERE room_id = ?", (room_id,)
        ).fetchone() is not None


def mark_greeted(room_id: str, company: str = None):
    with _db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO greeted_rooms (room_id, greeted_at, company) VALUES (?, ?, ?)",
            (room_id, _now(), company),
        )


def get_company(room_id: str) -> str | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT company FROM greeted_rooms WHERE room_id = ?", (room_id,)
        ).fetchone()
    return row["company"] if row else None


def get_ticket_session(room_id: str):
    with _db() as conn:
        row = conn.execute(
            "SELECT state, issue, tried, reproduce, when_started, last_activity, "
            "staff_triggered, initiating_staff "
            "FROM ticket_sessions WHERE room_id = ?",
            (room_id,),
        ).fetchone()
    if not row:
        return None
    elapsed = (
        datetime.now(timezone.utc) - datetime.fromisoformat(row["last_activity"])
    ).total_seconds()
    if elapsed > TICKET_TIMEOUT_SECS:
        clear_ticket_session(room_id)
        return None
    return {
        "state":            row["state"],
        "issue":            row["issue"],
        "tried":            row["tried"],
        "reproduce":        row["reproduce"],
        "when_started":     row["when_started"],
        "staff_triggered":  bool(row["staff_triggered"]),
        "initiating_staff": row["initiating_staff"],
    }


def set_ticket_session(
    room_id: str,
    state: str,
    issue: str = None,
    tried: str = None,
    reproduce: str = None,
    when_started: str = None,
    staff_triggered: bool | None = None,
    initiating_staff: str | None = None,
):
    with _db() as conn:
        if staff_triggered is None or initiating_staff is None:
            existing = conn.execute(
                "SELECT staff_triggered, initiating_staff FROM ticket_sessions WHERE room_id = ?",
                (room_id,),
            ).fetchone()
            if existing:
                if staff_triggered is None:
                    staff_triggered = bool(existing["staff_triggered"])
                if initiating_staff is None:
                    initiating_staff = existing["initiating_staff"]
        conn.execute(
            "INSERT OR REPLACE INTO ticket_sessions "
            "(room_id, state, issue, tried, reproduce, when_started, last_activity, "
            "staff_triggered, initiating_staff) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (room_id, state, issue, tried, reproduce, when_started, _now(),
             int(staff_triggered or False), initiating_staff),
        )


def clear_ticket_session(room_id: str):
    with _db() as conn:
        conn.execute("DELETE FROM ticket_sessions WHERE room_id = ?", (room_id,))


def count_recent_tickets(room_id: str) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    with _db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM ticket_log WHERE room_id = ? AND created_at > ?",
            (room_id, cutoff),
        ).fetchone()
    return row["cnt"] if row else 0


def log_ticket(room_id: str):
    with _db() as conn:
        conn.execute(
            "INSERT INTO ticket_log (room_id, created_at) VALUES (?, ?)",
            (room_id, _now()),
        )


def get_guest_session(room_id: str):
    with _db() as conn:
        row = conn.execute(
            "SELECT state, contact_name, company_name, phone, message, preference, last_activity "
            "FROM guest_contact_sessions WHERE room_id = ?",
            (room_id,),
        ).fetchone()
    if not row:
        return None
    elapsed = (
        datetime.now(timezone.utc) - datetime.fromisoformat(row["last_activity"])
    ).total_seconds()
    if elapsed > TICKET_TIMEOUT_SECS:
        clear_guest_session(room_id)
        return None
    return {
        "state":        row["state"],
        "contact_name": row["contact_name"],
        "company_name": row["company_name"],
        "phone":        row["phone"],
        "message":      row["message"],
        "preference":   row["preference"],
    }


def set_guest_session(room_id: str, state: str, **kwargs):
    with _db() as conn:
        existing = conn.execute(
            "SELECT contact_name, company_name, phone, message, preference "
            "FROM guest_contact_sessions WHERE room_id = ?",
            (room_id,),
        ).fetchone()
        vals = dict(existing) if existing else {}
        vals.update(kwargs)
        conn.execute(
            "INSERT OR REPLACE INTO guest_contact_sessions "
            "(room_id, state, contact_name, company_name, phone, message, preference, last_activity) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (room_id, state, vals.get("contact_name"), vals.get("company_name"),
             vals.get("phone"), vals.get("message"), vals.get("preference"), _now()),
        )


def clear_guest_session(room_id: str):
    with _db() as conn:
        conn.execute("DELETE FROM guest_contact_sessions WHERE room_id = ?", (room_id,))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Business hours ─────────────────────────────────────────────────────────────

HOLIDAY_CONFIG_PATH = "/opt/bracer-register/holiday.json"


def _load_holiday_config() -> dict:
    try:
        with open(HOLIDAY_CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, Exception):
        return {"enabled": False, "message": ""}


def is_holiday_mode() -> bool:
    return _load_holiday_config().get("enabled", False)


def get_holiday_message() -> str:
    config = _load_holiday_config()
    return config.get("message", "") or "We are currently closed for the holidays."


def is_business_hours() -> bool:
    if is_holiday_mode():
        return False
    now = datetime.now(TIMEZONE)
    return now.weekday() < 5 and 8 <= now.hour < 17


# ── Autoresponder config ─────────────────────────────────────────────────────

def _load_autoresponder_config() -> dict:
    try:
        with open(AUTORESPONDER_CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"enabled": False, "delay_minutes": 20, "message": ""}


def _should_autorespond(room_id: str) -> bool:
    config = _load_autoresponder_config()
    if not config.get("enabled", False):
        return False
    if not config.get("message", "").strip():
        return False
    delay = max(1, config.get("delay_minutes", 20))
    last_ts = _room_last_message.get(room_id)
    if last_ts is None:
        return False
    elapsed_min = (datetime.now(timezone.utc).timestamp() - last_ts) / 60.0
    return elapsed_min >= delay


def _get_autoresponder_message() -> str:
    config = _load_autoresponder_config()
    return config.get("message", "").strip()


def _record_room_activity(room_id: str):
    _room_last_message[room_id] = datetime.now(timezone.utc).timestamp()


# ── RC API helpers ─────────────────────────────────────────────────────────────

def _rc_bot_headers() -> dict:
    return {
        "X-Auth-Token": RC_BOT_TOKEN,
        "X-User-Id": RC_BOT_USER_ID,
        "Content-Type": "application/json",
    }


def _rc_admin_headers() -> dict:
    return {
        "X-Auth-Token": RC_ADMIN_TOKEN,
        "X-User-Id": RC_ADMIN_USER_ID,
        "Content-Type": "application/json",
    }


async def _rc_get_message(message_id: str) -> dict | None:
    """Fetch a full message by ID via admin API (includes attachments)."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{RC_URL}/api/v1/chat.getMessage",
            params={"msgId": message_id},
            headers=_rc_admin_headers(),
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("message")
    return None


async def _send(room_id: str, text: str, delay: float = 1.5):
    """Send a message to a RC room as the bot user."""
    if delay > 0:
        await asyncio.sleep(delay)
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{RC_URL}/api/v1/chat.postMessage",
            headers=_rc_bot_headers(),
            json={"roomId": room_id, "text": text},
        )
        if resp.status_code != 200 or not resp.json().get("success"):
            log.warning(f"Failed to send message to {room_id}: {resp.status_code} {resp.text[:200]}")


async def _download_rc_file(file_url: str) -> tuple[bytes, str]:
    """Download a file from Rocket.Chat. Returns (data, filename)."""
    # file_url may be relative (/file-upload/...) or absolute
    if file_url.startswith("/"):
        url = f"{RC_URL}{file_url}"
    elif file_url.startswith("http"):
        url = file_url
    else:
        url = f"{RC_URL}/{file_url}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_rc_bot_headers())
        if resp.status_code != 200:
            raise RuntimeError(f"RC file download failed: {resp.status_code} for {file_url}")
        data = resp.content
        # Extract filename from URL path
        filename = file_url.rsplit("/", 1)[-1] if "/" in file_url else "screenshot.png"
        return data, filename


async def _get_company_name(hostname: str) -> str | None:
    """Look up company name via RC admin API — find company-*-broadcast channel the user belongs to."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Get the RC user for this hostname
        resp = await client.get(
            f"{RC_URL}/api/v1/users.info",
            headers=_rc_bot_headers(),
            params={"username": hostname},
        )
        if resp.status_code != 200 or not resp.json().get("success"):
            return None

        rc_user_id = resp.json()["user"]["_id"]

        # Get the user's channel subscriptions
        resp = await client.get(
            f"{RC_URL}/api/v1/channels.list.joined",
            headers={"X-Auth-Token": RC_BOT_TOKEN, "X-User-Id": RC_BOT_USER_ID},
            params={"count": 200},
        )
        if resp.status_code != 200:
            return None

        # Search through all company broadcast channels for this user's membership
        resp = await client.get(
            f"{RC_URL}/api/v1/rooms.adminRooms",
            headers=_rc_admin_headers(),
            params={"filter": "company-", "types[]": "c", "count": 200},
        )
        if resp.status_code != 200 or not resp.json().get("success"):
            return None

        for room in resp.json().get("rooms", []):
            rname = room.get("name", "")
            if not (rname.startswith("company-") and rname.endswith("-broadcast")):
                continue
            # Check if the machine user is a member
            mem_resp = await client.get(
                f"{RC_URL}/api/v1/channels.members",
                headers=_rc_admin_headers(),
                params={"roomId": room["_id"], "count": 500},
            )
            if mem_resp.status_code == 200:
                members = [m.get("username") for m in mem_resp.json().get("members", [])]
                if hostname in members:
                    # Extract company name from room display name
                    fname = room.get("fname") or room.get("name") or ""
                    for sep in (" \u2014 ", " \u2013 ", " - "):
                        if sep in fname:
                            return fname.split(sep)[0].strip()
                    # Fallback: derive from slug
                    slug = rname.replace("company-", "").replace("-broadcast", "")
                    return slug.replace("-", " ").title()
    return None


async def _get_room_client_displayname(room_id: str) -> str | None:
    """Return the display name of the non-staff, non-bot user in the support room."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Machine rooms are private groups
        resp = await client.get(
            f"{RC_URL}/api/v1/groups.members",
            headers=_rc_bot_headers(),
            params={"roomId": room_id, "count": 50},
        )
        if resp.status_code != 200 or not resp.json().get("success"):
            # Try channels endpoint as fallback
            resp = await client.get(
                f"{RC_URL}/api/v1/channels.members",
                headers=_rc_bot_headers(),
                params={"roomId": room_id, "count": 50},
            )
            if resp.status_code != 200:
                return None

        for member in resp.json().get("members", []):
            uname = member.get("username", "")
            if uname == BOT_USERNAME or uname in STAFF_USERNAMES:
                continue
            return member.get("name") or uname
    return None


# ── SuperOps ───────────────────────────────────────────────────────────────────

async def _get_superops_client_id(company_name: str) -> str | None:
    headers = {
        "authorization": f"Bearer {SUPEROPS_API_KEY}",
        "CustomerSubDomain": SUPEROPS_SUBDOMAIN,
        "Content-Type": "application/json",
    }
    query = """
    query {
        getClientList(input: { page: 1, pageSize: 200 }) {
            clients { accountId name }
        }
    }
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(SUPEROPS_GQL_URL, headers=headers, json={"query": query})
        data = resp.json()

    clients = (data.get("data") or {}).get("getClientList", {}).get("clients", [])
    name_lower = company_name.lower()
    for c in clients:
        if (c.get("name") or "").lower() == name_lower:
            return c["accountId"]
    for c in clients:
        sops_name = (c.get("name") or "").lower()
        if name_lower in sops_name or sops_name in name_lower:
            return c["accountId"]
    return None


async def create_superops_ticket(
    subject: str,
    description: str,
    priority: str,
    account_id: str | None,
) -> tuple[str, str]:
    headers = {
        "authorization": f"Bearer {SUPEROPS_API_KEY}",
        "CustomerSubDomain": SUPEROPS_SUBDOMAIN,
        "Content-Type": "application/json",
    }
    mutation = """
    mutation CreateTicket($input: CreateTicketInput!) {
        createTicket(input: $input) {
            ticketId
            displayId
        }
    }
    """
    variables: dict = {
        "input": {
            "subject": subject[:120],
            "description": description,
            "priority": priority,
            "source": "INSTANT_MESSAGING",
            "requestType": "Incident",
        }
    }
    if account_id:
        variables["input"]["client"] = {"accountId": account_id}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            SUPEROPS_GQL_URL,
            headers=headers,
            json={"query": mutation, "variables": variables},
        )
        data = resp.json()

    errors = data.get("errors")
    if errors:
        raise RuntimeError(f"SuperOps GraphQL errors: {errors}")

    ticket = (data.get("data") or {}).get("createTicket") or {}
    internal_id = str(ticket.get("ticketId") or "?")
    display_id = str(ticket.get("displayId") or internal_id)
    return internal_id, display_id


# ── Diagnostics ───────────────────────────────────────────────────────────────

_DIAG_HEADERS = {"**Machine Info**", "**Version Info**", "**CPU / RAM**", "**Disk Info**", "**Network Interfaces**", "**Uptime**"}


def _is_diag_response(body: str) -> bool:
    return any(h in body for h in _DIAG_HEADERS)


def _parse_machine_info(body: str) -> dict | None:
    if "**Machine Info**" not in body:
        return None
    info = {}
    for line in body.splitlines():
        line = line.strip()
        for key in ("Hostname:", "User:", "Serial:", "IP:", "MAC:", "Version:"):
            if line.startswith(key):
                info[key.rstrip(":").lower()] = line[len(key):].strip()
    return info if info else None


def _handle_diagnostic(room_id: str, body: str):
    """Process a diagnostic response — cache and signal if all 6 collected."""
    parsed = _parse_machine_info(body)
    if parsed:
        _room_machine_info[room_id] = parsed
        log.info(f"Cached machine info for room={room_id}: user={parsed.get('user')} serial=...{(parsed.get('serial') or '')[-6:]}")
    if room_id not in _room_diag_text:
        _room_diag_text[room_id] = []
    _room_diag_text[room_id].append(body)
    # Signal the Event if we have all 6 diagnostic responses
    ev = _room_diag_events.get(room_id)
    if ev and len(_room_diag_text.get(room_id, [])) >= 6:
        ev.set()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _is_guest_sender(username: str) -> bool:
    return username.startswith("guest-")


def _truncate(text: str) -> str:
    return text[:INPUT_MAX_LEN] if len(text) > INPUT_MAX_LEN else text


# ── Guest after-hours flow ────────────────────────────────────────────────────

async def _handle_guest_afterhours(room_id: str, body: str):
    """Handle the after-hours contact collection flow for guest visitors.
    Returns True if the message was handled, False to fall through."""
    gsession = get_guest_session(room_id)
    if not gsession:
        return False

    state = gsession["state"]

    if state == "await_name":
        set_guest_session(room_id, "await_company", contact_name=body)
        await _send(room_id, "Thanks! What company are you with?")
        return True

    if state == "await_company":
        set_guest_session(room_id, "await_phone", company_name=body)
        await _send(room_id, "What's the best phone number to reach you?")
        return True

    if state == "await_phone":
        set_guest_session(room_id, "await_message", phone=body)
        await _send(room_id,
            "What can we help you with? Please describe your issue and we'll include it in the ticket.")
        return True

    if state == "await_message":
        set_guest_session(room_id, "await_preference", message=body)
        await _send(room_id,
            "Would you prefer a call back or an email?\n1 = Call back\n2 = Email")
        return True

    if state == "await_preference":
        if body not in ("1", "2"):
            await _send(room_id, "Please reply with 1 (Call back) or 2 (Email).")
            return True
        preference = "Call back" if body == "1" else "Email"
        set_guest_session(room_id, "await_screenshot_yn", preference=preference)
        await _send(room_id, "Do you have a screenshot of the issue? (yes/no)")
        return True

    if state == "await_screenshot_yn":
        answer = body.lower().strip()
        if answer in ("yes", "y", "yeah", "yep", "sure"):
            set_guest_session(room_id, "await_screenshot")
            await _send(room_id,
                "Please paste or attach your screenshot now using the attachment button.")
            return True
        elif answer in ("no", "n", "nope", "nah"):
            return await _finalize_guest_ticket(room_id)
        else:
            await _send(room_id, "Please reply yes or no.")
            return True

    if state == "await_screenshot":
        if body.lower().strip() in ("skip", "no", "none"):
            return await _finalize_guest_ticket(room_id)
        await _send(room_id,
            "I'm waiting for a screenshot image. Please paste or attach it, "
            "or type 'skip' to create the ticket without one.")
        return True

    return False


async def _finalize_guest_ticket(room_id: str, screenshot_url: str = None):
    """Create the SuperOps ticket from collected guest contact info."""
    gs = get_guest_session(room_id)
    if not gs:
        return True

    contact_name = gs.get("contact_name") or "Unknown"
    company_name = gs.get("company_name") or "Unknown"
    phone        = gs.get("phone") or "Not provided"
    message      = gs.get("message") or "No details provided"
    preference   = gs.get("preference") or "Not specified"

    account_id = None
    try:
        account_id = await _get_superops_client_id(company_name)
    except Exception as exc:
        log.warning(f"Guest company lookup failed room={room_id}: {exc}")

    screenshot_html = ""
    if screenshot_url:
        try:
            file_data, filename = await _download_rc_file(screenshot_url)
            b64 = base64.b64encode(file_data).decode("ascii")
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
            mime = f"image/{ext}" if ext in ("png", "jpg", "jpeg", "gif", "webp") else "image/png"
            screenshot_html = f'<p><strong>Screenshot:</strong></p><p><img src="data:{mime};base64,{b64}" style="max-width:600px;" /></p>'
            log.info(f"Guest screenshot embedded ({len(file_data)} bytes)")
        except Exception as exc:
            log.warning(f"Guest screenshot download failed: {exc}")
            screenshot_html = "<p><strong>Screenshot:</strong> Upload failed</p>"

    subject = f"After-hours website chat - {contact_name} ({company_name})"
    description = (
        f"<p><strong>After-Hours Website Chat Message</strong></p>"
        f"<p><strong>Contact:</strong> {html.escape(contact_name)}</p>"
        f"<p><strong>Company:</strong> {html.escape(company_name)}</p>"
        f"<p><strong>Phone:</strong> {html.escape(phone)}</p>"
        f"<p><strong>Preferred contact method:</strong> {html.escape(preference)}</p>"
        f"<p><strong>Message:</strong></p><p>{html.escape(message)}</p>"
        f"{screenshot_html if screenshot_html else '<p><strong>Screenshot:</strong> None provided</p>'}"
        f"<hr><p><em>Submitted via bracer.ca live chat widget (after hours)</em></p>"
    )

    try:
        internal_id, display_id = await create_superops_ticket(
            subject, description, "Medium", account_id
        )
        log_ticket(room_id)
        clear_guest_session(room_id)
        await _send(room_id,
            f"I've opened ticket #{display_id} for you. "
            f"Someone from our team will reach out next business morning.\n\n"
            f"If this becomes urgent before then, call 587-400-9573 and select "
            f"the after-hours emergency option.")
        log.info(
            f"Guest after-hours ticket #{display_id} created - "
            f"room={room_id} contact={contact_name} company={company_name} "
            f"screenshot={'yes' if screenshot_url else 'no'}"
        )
    except Exception as exc:
        log.error(f"Guest ticket creation failed room={room_id}: {exc}")
        clear_guest_session(room_id)
        await _send(room_id,
            "Sorry, there was an error creating the ticket. "
            "Please call 587-400-9573 and select the after-hours emergency option, "
            "or email support@bracer.ca and we'll follow up next business day.")
    return True


# ── Machine ticket flow ───────────────────────────────────────────────────────

async def _finalize_machine_ticket(room_id: str, channel_name: str, session: dict, screenshot_url: str = None):
    """Create a SuperOps ticket from the !ticket flow data."""
    priority = "Medium"
    issue = session["issue"]
    hostname = channel_name  # In RC, room name IS the hostname for machine rooms
    company = get_company(room_id)
    clear_ticket_session(room_id)

    if not company:
        try:
            company = await _get_company_name(hostname)
            if company:
                log.info(f"Live company lookup succeeded room={room_id} company={company}")
        except Exception as exc:
            log.warning(f"Live company lookup failed room={room_id}: {exc}")

    if not company:
        log.warning(f"Could not identify company for room={room_id} host={hostname}")
        await _send(room_id,
            "Sorry, I couldn't identify your company to open a ticket. "
            "Please call us at 587-400-9573 or email support@bracersystems.com.")
        return

    account_id = None
    try:
        account_id = await _get_superops_client_id(company)
    except Exception as exc:
        log.warning(f"Client ID lookup failed room={room_id}: {exc}")

    if not account_id:
        log.warning(f"No SuperOps client found for company='{company}' room={room_id}")
        await _send(room_id,
            "Sorry, I couldn't match your company in our system. "
            "Please call us at 587-400-9573 or email support@bracersystems.com.")
        return

    initiated_note = ""
    if session.get("initiating_staff"):
        staff_label = session["initiating_staff"].replace(".", " ").title()
        initiated_note = f"<br>Initiated by: Technician {html.escape(staff_label)} (on client's behalf)"

    # Build screenshot HTML
    screenshot_html = ""
    if screenshot_url:
        try:
            file_data, filename = await _download_rc_file(screenshot_url)
            b64 = base64.b64encode(file_data).decode("ascii")
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
            mime = f"image/{ext}" if ext in ("png", "jpg", "jpeg", "gif", "webp") else "image/png"
            screenshot_html = f'<p><strong>Screenshot:</strong></p><p><img src="data:{mime};base64,{b64}" style="max-width:600px;" /></p>'
            log.info(f"Screenshot embedded in ticket description ({len(file_data)} bytes)")
        except Exception as exc:
            log.warning(f"Screenshot download failed, creating ticket without it: {exc}")
            screenshot_html = "<p><strong>Screenshot:</strong> Upload failed</p>"

    # Send diagnostic commands and wait for responses
    _room_diag_text.pop(room_id, None)
    _room_machine_info.pop(room_id, None)
    diag_event = asyncio.Event()
    _room_diag_events[room_id] = diag_event

    for cmd in ("!machineinfo", "!version", "!cpu", "!disk", "!ip", "!uptime"):
        await _send(room_id, cmd, delay=0)

    # Wait for diagnostic responses (max 5 seconds)
    try:
        await asyncio.wait_for(diag_event.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        log.info(f"Diagnostic timeout room={room_id} got={len(_room_diag_text.get(room_id, []))}/6")

    _room_diag_events.pop(room_id, None)

    # Get cached machine info and full diagnostics
    minfo = _room_machine_info.get(room_id, {})
    logged_user = minfo.get("user", "N/A")
    serial = minfo.get("serial", "N/A")
    diag_texts = _room_diag_text.pop(room_id, [])
    _room_machine_info.pop(room_id, None)

    # Build diagnostics HTML block
    diag_html = ""
    if diag_texts:
        diag_lines = "<br>".join(html.escape(line) for block in diag_texts for line in block.splitlines() if line.strip())
        diag_html = f'<details><summary><strong>System Diagnostics</strong></summary><p style="font-family:monospace;font-size:12px;">{diag_lines}</p></details>'

    description = (
        f"<p><strong>Issue:</strong> {html.escape(issue)}</p>"
        f"<p><strong>When it started:</strong> {html.escape(session.get('when_started') or 'N/A')}</p>"
        f"{screenshot_html if screenshot_html else '<p><strong>Screenshot:</strong> None provided</p>'}"
        f"<hr><p>Machine: {html.escape(hostname)}<br>Logged-in user: {html.escape(logged_user)}<br>Serial: {html.escape(serial)}<br>Company: {html.escape(company)}<br>Room: {html.escape(room_id)}"
        f"{initiated_note}</p>"
        f"{diag_html}"
    )

    try:
        subject = f"New ticket from {logged_user} @ {hostname}" if logged_user != "N/A" else issue
        internal_id, display_id = await create_superops_ticket(subject, description, priority, account_id)
        log_ticket(room_id)
        await _send(room_id,
            f"Done! Ticket #{display_id} created. A technician will follow up.\n"
            "View your ticket: https://bracer.superops.ai/portal")
        log.info(
            f"Ticket #{display_id} created - "
            f"room={room_id} host={hostname} company={company} "
            f"screenshot={'yes' if screenshot_url else 'no'}"
        )
    except Exception as exc:
        log.error(f"Ticket creation failed room={room_id}: {exc}")
        await _send(room_id,
            "Sorry, there was an error creating the ticket. "
            "Please call us at 587-400-9573 or email support@bracersystems.com.")


# ── Image handlers ────────────────────────────────────────────────────────────

async def _handle_image(room_id: str, channel_name: str, user_name: str, file_url: str):
    """Handle an image message (file attachment without text)."""
    # Staff: allow screenshots only in staff-triggered sessions
    if user_name in STAFF_USERNAMES:
        session = get_ticket_session(room_id)
        if session and session.get("staff_triggered") and session["state"] == "await_ticket_screenshot":
            await _send(room_id, "Got it! Creating your ticket now...")
            await _finalize_machine_ticket(room_id, channel_name, session, screenshot_url=file_url)
        return

    is_guest = _is_guest_sender(user_name)

    # Guest screenshot
    if is_guest:
        gsession = get_guest_session(room_id)
        if gsession and gsession["state"] == "await_screenshot":
            await _send(room_id, "Got it! Creating your ticket now...")
            await _finalize_guest_ticket(room_id, screenshot_url=file_url)
            return

    # Client screenshot
    session = get_ticket_session(room_id)
    if session and session["state"] == "await_ticket_screenshot":
        await _send(room_id, "Got it! Creating your ticket now...")
        await _finalize_machine_ticket(room_id, channel_name, session, screenshot_url=file_url)


# ── Main message handler ─────────────────────────────────────────────────────

async def _handle_message(room_id: str, channel_name: str, user_name: str, body: str,
                          should_autorespond: bool, file_url: str = ""):
    """Handle a text message from the webhook."""

    # Staff: can trigger !ticket, !cancel, or advance a staff-triggered session
    if user_name in STAFF_USERNAMES:
        if body.lower() == "!ticket":
            await _handle_staff_ticket_trigger(room_id, channel_name, user_name)
            return
        if body.lower().strip() == "!cancel":
            session = get_ticket_session(room_id)
            if session:
                clear_ticket_session(room_id)
                await _send(room_id, "Ticket cancelled.")
            return
        session = get_ticket_session(room_id)
        if not (session and session.get("staff_triggered")):
            return
        # Fall through to session handling for staff-triggered sessions

    # Send autoresponder if room was idle
    if should_autorespond:
        msg = _get_autoresponder_message()
        if msg:
            await _send(room_id, msg)
            _record_room_activity(room_id)
            log.info(f"Autoresponder sent room={room_id} sender={user_name}")

    is_guest = _is_guest_sender(user_name)

    # ── Guest after-hours contact flow ────────────────────────────────────
    if is_guest:
        handled = await _handle_guest_afterhours(room_id, body)
        if handled:
            return

    # ── Cancel check ──────────────────────────────────────────────────────
    if body.lower().strip() == "!cancel":
        session = get_ticket_session(room_id)
        if session:
            clear_ticket_session(room_id)
            await _send(room_id, "Ticket cancelled.")
        return

    # ── Active ticket session ─────────────────────────────────────────────
    session = get_ticket_session(room_id)
    if session:
        if session["state"] == "await_issue":
            set_ticket_session(room_id, "await_when", issue=body)
            await _send(room_id, "When did this start?")
            return

        if session["state"] == "await_when":
            set_ticket_session(room_id, "await_ticket_screenshot_yn",
                issue=session["issue"], when_started=body)
            await _send(room_id, "Can you send a screenshot of the issue? (yes/no)")
            return

        if session["state"] == "await_ticket_screenshot_yn":
            answer = body.lower().strip()
            if answer in ("yes", "y", "yeah", "yep", "sure"):
                set_ticket_session(room_id, "await_ticket_screenshot",
                    issue=session["issue"], when_started=session["when_started"])
                await _send(room_id,
                    "Please paste or attach your screenshot now using the screenshot button below.")
                return
            elif answer in ("no", "n", "nope", "nah"):
                return await _finalize_machine_ticket(
                    room_id, channel_name, session)
            else:
                await _send(room_id, "Please reply yes or no.")
                return

        if session["state"] == "await_ticket_screenshot":
            # Check if this message has a file attachment
            if file_url:
                await _send(room_id, "Got it! Creating your ticket now...")
                return await _finalize_machine_ticket(
                    room_id, channel_name, session, screenshot_url=file_url)
            if body.lower().strip() in ("skip", "no", "none"):
                return await _finalize_machine_ticket(
                    room_id, channel_name, session)
            await _send(room_id,
                "I'm waiting for a screenshot image. Please paste or attach it, "
                "or type 'skip' to create the ticket without one.")
            return

    # ── !ticket command ───────────────────────────────────────────────────
    if body.lower() == "!ticket":
        if count_recent_tickets(room_id) >= TICKET_RATE_LIMIT:
            await _send(room_id,
                "You've opened several tickets recently. "
                "If this is urgent please call us at 587-400-9573.")
            return
        set_ticket_session(room_id, "await_issue")
        await _send(room_id, "What's the issue you're experiencing?\n(!cancel to stop)")
        return

    # ── Greeting (once per room) ──────────────────────────────────────────
    if not has_greeted(room_id):
        if is_guest:
            mark_greeted(room_id, None)
            if is_business_hours():
                log.info(f"Guest greeted (business hours) room={room_id}")
                await _send(room_id, GUEST_GREETING_BUSINESS)
            else:
                log.info(f"Guest greeted (after hours) room={room_id} - starting contact flow")
                set_guest_session(room_id, "await_name")
                if is_holiday_mode():
                    holiday_msg = get_holiday_message()
                    greeting = (
                        f"{holiday_msg}\n\n"
                        "For emergencies, call 587-400-9573 and select the after-hours emergency option "
                        "to reach a technician immediately.\n\n"
                        "If you'd like to open a ticket for a callback on the next business day, "
                        "I can help with that right now. Just start by telling me your name."
                    )
                else:
                    greeting = GUEST_GREETING_AFTERHOURS
                await _send(room_id, greeting)
        else:
            hostname = channel_name
            company = None
            try:
                company = await _get_company_name(hostname)
            except Exception as exc:
                log.warning(f"Company lookup failed room={room_id}: {exc}")
            mark_greeted(room_id, company)
            log.info(f"Greeted room={room_id} host={hostname} company={company}")
            greeting = GREETING_BUSINESS if is_business_hours() else GREETING_AFTERHOURS
            await _send(room_id, greeting)


async def _handle_staff_ticket_trigger(room_id: str, channel_name: str, user_name: str):
    """Handle !ticket command from a staff user."""
    if count_recent_tickets(room_id) >= TICKET_RATE_LIMIT:
        await _send(room_id,
            "Rate limit reached for this room. Please open a ticket manually in SuperOps.")
        return
    client_name = await _get_room_client_displayname(room_id)
    name_part = f" {client_name}," if client_name else ""
    set_ticket_session(room_id, "await_issue", staff_triggered=True, initiating_staff=user_name)
    await _send(room_id,
        f"I'll help create a ticket.{name_part} Can you describe the issue?\n(!cancel to stop)")
    log.info(f"Staff-triggered !ticket started room={room_id} staff={user_name}")
