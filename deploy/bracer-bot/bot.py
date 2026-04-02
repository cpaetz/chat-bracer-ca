#!/usr/bin/env python3
"""
bracer-bot — Bracer Systems support bot for Matrix chat.

Phase 5 of Bracer Chat project.
Python + matrix-nio (async), systemd service on chat-bracer-ca.

Behaviour:
  - Greets on first client message per room (business-hours-aware)
  - !ticket → SuperOps ticket flow (3 questions + screenshot, 10-min timeout)
  - !cancel → cancels active ticket flow (works for both clients and staff)
  - Never responds to staff or itself
  - Only joins rooms created by bracer-register
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

import aiohttp
from nio import AsyncClient, AsyncClientConfig, JoinedMembersResponse, LoginResponse, RoomMessageText, RoomMessageImage, SyncResponse

# ── Config ─────────────────────────────────────────────────────────────────────

MATRIX_HOMESERVER   = os.environ.get("MATRIX_HOMESERVER", "http://localhost:8008")
BOT_USER_ID         = os.environ.get("BOT_USER_ID", "@bracerbot:chat.bracer.ca")
BOT_PASSWORD        = os.environ["BOT_PASSWORD"]
STAFF_USERS         = set(filter(None, os.environ.get("STAFF_USERS", "").split(",")))
SUPEROPS_API_KEY    = os.environ["SUPEROPS_API_KEY"]
SUPEROPS_SUBDOMAIN  = os.environ.get("SUPEROPS_SUBDOMAIN", "bracer")
SYNAPSE_ADMIN_TOKEN = os.environ.get("SYNAPSE_ADMIN_TOKEN", "")
DB_PATH             = os.environ.get("DB_PATH", "/opt/bracer-bot/bracer_bot.db")

TIMEZONE             = ZoneInfo("America/Edmonton")
TICKET_TIMEOUT_SECS  = 600   # 10 minutes
TICKET_RATE_LIMIT    = 3     # max tickets per room per hour
INPUT_MAX_LEN        = 2000  # max chars per user input field

SUPEROPS_GQL_URL = "https://api.superops.ai/msp"
SUPEROPS_UPLOAD_URL = "https://api.superops.ai/upload"

AUTORESPONDER_CONFIG_PATH = "/opt/bracer-register/autoresponder.json"

# In-memory: tracks the timestamp of the last message in each room (any sender)
_room_last_message: dict[str, float] = {}  # room_id -> epoch seconds

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
        for col in ("tried TEXT", "reproduce TEXT", "when_started TEXT", "pending_ticket_id TEXT", "screenshot_mxc TEXT", "staff_triggered INTEGER DEFAULT 0", "initiating_staff TEXT"):
            try:
                conn.execute(f"ALTER TABLE ticket_sessions ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass
        for col in ("pending_ticket_id TEXT", "screenshot_mxc TEXT"):
            try:
                conn.execute(f"ALTER TABLE guest_contact_sessions ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass

    # Restrict DB permissions - no world-read
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
    """Count tickets created from this room in the last hour."""
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
        return False  # Holiday mode = treat as after-hours
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
    """Return True if the room has been idle for at least delay_minutes."""
    config = _load_autoresponder_config()
    if not config.get("enabled", False):
        return False
    if not config.get("message", "").strip():
        return False
    delay = max(1, config.get("delay_minutes", 20))
    last_ts = _room_last_message.get(room_id)
    if last_ts is None:
        # No prior message tracked - treat as idle (first message since bot started)
        return True
    elapsed_min = (datetime.now(timezone.utc).timestamp() - last_ts) / 60.0
    return elapsed_min >= delay


def _get_autoresponder_message() -> str:
    config = _load_autoresponder_config()
    return config.get("message", "").strip()


def _record_room_activity(room_id: str):
    """Record that a message was sent in this room (any sender)."""
    _room_last_message[room_id] = datetime.now(timezone.utc).timestamp()


# ── Synapse admin ──────────────────────────────────────────────────────────────

async def _is_bracer_room(room_id: str) -> bool:
    """Verify room was created by @bracer-register before the bot joins."""
    if not SYNAPSE_ADMIN_TOKEN:
        return True
    server = BOT_USER_ID.split(":", 1)[1]
    expected_creator = f"@bracer-register:{server}"
    headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}
    url = f"{MATRIX_HOMESERVER}/_synapse/admin/v1/rooms/{room_id}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    return False
                data = await resp.json(content_type=None)
        return data.get("creator") == expected_creator
    except Exception:
        return False


async def _get_company_name(hostname: str) -> str | None:
    """Look up company name via Synapse admin API using machine user's broadcast room."""
    if not SYNAPSE_ADMIN_TOKEN:
        return None
    server = BOT_USER_ID.split(":", 1)[1]
    machine_user = f"@{hostname}:{server}"
    base = MATRIX_HOMESERVER
    headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        url = f"{base}/_synapse/admin/v1/users/{machine_user}/joined_rooms"
        async with session.get(url, headers=headers) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)

        for room_id in data.get("joined_rooms", []):
            url2 = f"{base}/_synapse/admin/v1/rooms/{room_id}"
            async with session.get(url2, headers=headers) as resp:
                if resp.status != 200:
                    continue
                rdata = await resp.json(content_type=None)
            alias = rdata.get("canonical_alias") or ""
            if alias.startswith("#company-"):
                name = rdata.get("name") or ""
                for sep in (" \u2014 ", " \u2013 ", " - "):
                    if sep in name:
                        return name.split(sep)[0].strip()
                return name.strip() or None
    return None


# ── SuperOps ───────────────────────────────────────────────────────────────────

async def _get_superops_client_id(company_name: str) -> str | None:
    """Fetch SuperOps client list and find matching accountId by company name."""
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
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.post(SUPEROPS_GQL_URL, headers=headers, json={"query": query}) as resp:
            data = await resp.json(content_type=None)

    clients = (data.get("data") or {}).get("getClientList", {}).get("clients", [])
    name_lower = company_name.lower()
    for client in clients:
        if (client.get("name") or "").lower() == name_lower:
            return client["accountId"]
    for client in clients:
        sops_name = (client.get("name") or "").lower()
        if name_lower in sops_name or sops_name in name_lower:
            return client["accountId"]
    return None


async def create_superops_ticket(
    subject: str,
    description: str,
    priority: str,
    account_id: str | None,
) -> tuple[str, str]:
    """GraphQL mutation to create a SuperOps ticket. Returns (internal_ticketId, displayId) tuple."""
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

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.post(
            SUPEROPS_GQL_URL,
            headers=headers,
            json={"query": mutation, "variables": variables},
        ) as resp:
            data = await resp.json(content_type=None)

    errors = data.get("errors")
    if errors:
        raise RuntimeError(f"SuperOps GraphQL errors: {errors}")

    ticket = (data.get("data") or {}).get("createTicket") or {}
    internal_id = str(ticket.get("ticketId") or "?")
    display_id = str(ticket.get("displayId") or internal_id)
    return internal_id, display_id


async def _download_matrix_media(mxc_url: str) -> tuple[bytes, str]:
    """Download media from Matrix via mxc:// URL. Returns (data, filename).
    Uses the admin token for auth (required by Synapse v1.149+)."""
    if not mxc_url.startswith("mxc://"):
        raise ValueError(f"Not an mxc URL: {mxc_url}")
    parts = mxc_url[6:].split("/", 1)
    server_name = parts[0]
    media_id = parts[1]
    headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

    urls = [
        f"{MATRIX_HOMESERVER}/_matrix/client/v1/media/download/{server_name}/{media_id}",
        f"{MATRIX_HOMESERVER}/_matrix/media/v3/download/{server_name}/{media_id}",
    ]

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        for url in urls:
            async with session.get(url, headers=headers) as resp:
                if resp.status == 200:
                    data = await resp.read()
                    cd = resp.headers.get("Content-Disposition", "")
                    filename = "screenshot.png"
                    if "filename=" in cd:
                        filename = cd.split("filename=")[-1].strip('" ')
                    return data, filename

    raise RuntimeError(f"Media download failed for {mxc_url}: all endpoints returned non-200")


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _send(client: AsyncClient, room_id: str, text: str):
    await client.room_send(
        room_id=room_id,
        message_type="m.room.message",
        content={"msgtype": "m.text", "body": text},
    )


def _is_guest_sender(sender: str) -> bool:
    """Check if the sender is a guest user from the website widget."""
    return sender.startswith("@guest-")


async def _handle_guest_afterhours(client: AsyncClient, room, room_id: str, body: str, log):
    """Handle the after-hours contact collection flow for guest chat visitors.
    Returns True if the message was handled, False to fall through."""
    gsession = get_guest_session(room_id)
    if not gsession:
        return False

    state = gsession["state"]

    if state == "await_name":
        set_guest_session(room_id, "await_company", contact_name=body)
        await _send(client, room_id, "Thanks! What company are you with?")
        return True

    if state == "await_company":
        set_guest_session(room_id, "await_phone", company_name=body)
        await _send(client, room_id, "What's the best phone number to reach you?")
        return True

    if state == "await_phone":
        set_guest_session(room_id, "await_message", phone=body)
        await _send(client, room_id,
            "What can we help you with? Please describe your issue and we'll include it in the ticket.")
        return True

    if state == "await_message":
        set_guest_session(room_id, "await_preference", message=body)
        await _send(client, room_id,
            "Would you prefer a call back or an email?\n1 = Call back\n2 = Email")
        return True

    if state == "await_preference":
        if body not in ("1", "2"):
            await _send(client, room_id, "Please reply with 1 (Call back) or 2 (Email).")
            return True

        preference = "Call back" if body == "1" else "Email"
        set_guest_session(room_id, "await_screenshot_yn", preference=preference)
        await _send(client, room_id,
            "Do you have a screenshot of the issue? (yes/no)")
        return True

    if state == "await_screenshot_yn":
        answer = body.lower().strip()
        if answer in ("yes", "y", "yeah", "yep", "sure"):
            set_guest_session(room_id, "await_screenshot")
            await _send(client, room_id,
                "Please paste or attach your screenshot now using the attachment button.")
            return True
        elif answer in ("no", "n", "nope", "nah"):
            return await _finalize_guest_ticket(client, room_id, log)
        else:
            await _send(client, room_id, "Please reply yes or no.")
            return True

    if state == "await_screenshot":
        if body.lower().strip() in ("skip", "no", "none"):
            return await _finalize_guest_ticket(client, room_id, log)
        await _send(client, room_id,
            "I'm waiting for a screenshot image. Please paste or attach it, "
            "or type 'skip' to create the ticket without one.")
        return True

    return False


async def _finalize_guest_ticket(client: AsyncClient, room_id: str, log, screenshot_mxc: str = None):
    """Create the SuperOps ticket from the collected guest contact info."""
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

    # Build screenshot HTML if provided
    screenshot_html = ""
    if screenshot_mxc:
        try:
            file_data, filename = await _download_matrix_media(screenshot_mxc)
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
        await _send(client, room_id,
            f"I've opened ticket #{display_id} for you. "
            f"Someone from our team will reach out next business morning.\n\n"
            f"If this becomes urgent before then, call 587-400-9573 and select "
            f"the after-hours emergency option.")
        log.info(
            f"Guest after-hours ticket #{display_id} created - "
            f"room={room_id} contact={contact_name} company={company_name} "
            f"screenshot={'yes' if screenshot_mxc else 'no'}"
        )
    except Exception as exc:
        log.error(f"Guest ticket creation failed room={room_id}: {exc}")
        clear_guest_session(room_id)
        await _send(client, room_id,
            "Sorry, there was an error creating the ticket. "
            "Please call 587-400-9573 and select the after-hours emergency option, "
            "or email support@bracer.ca and we'll follow up next business day.")
    return True


async def _handle_guest_image(client: AsyncClient, room, room_id: str, mxc_url: str, log):
    """Handle an image message during the guest after-hours flow.
    Returns True if handled, False to fall through."""
    gsession = get_guest_session(room_id)
    if not gsession:
        return False
    if gsession["state"] != "await_screenshot":
        return False

    await _send(client, room_id, "Got it! Creating your ticket now...")
    return await _finalize_guest_ticket(client, room_id, log, screenshot_mxc=mxc_url)


async def _finalize_machine_ticket(client: AsyncClient, room, room_id: str, session: dict, log, screenshot_mxc: str = None):
    """Create a SuperOps ticket from the !ticket flow data."""
    priority = "Medium"

    issue    = session["issue"]
    hostname = _hostname_from_room(room)
    company  = get_company(room_id)
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
        await _send(client, room_id,
            "Sorry, I couldn't identify your company to open a ticket. "
            "Please call us at 1-888-272-2371 or email support@bracersystems.com.")
        return

    account_id = None
    try:
        account_id = await _get_superops_client_id(company)
    except Exception as exc:
        log.warning(f"Client ID lookup failed room={room_id}: {exc}")

    if not account_id:
        log.warning(f"No SuperOps client found for company='{company}' room={room_id}")
        await _send(client, room_id,
            "Sorry, I couldn't match your company in our system. "
            "Please call us at 1-888-272-2371 or email support@bracersystems.com.")
        return

    initiated_note = ""
    if session.get("initiating_staff"):
        staff_label = session["initiating_staff"].split(":")[0].lstrip("@").replace(".", " ").title()
        initiated_note = f"<br>Initiated by: Technician {html.escape(staff_label)} (on client's behalf)"

    # Build screenshot HTML if provided
    screenshot_html = ""
    if screenshot_mxc:
        try:
            file_data, filename = await _download_matrix_media(screenshot_mxc)
            b64 = base64.b64encode(file_data).decode("ascii")
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
            mime = f"image/{ext}" if ext in ("png", "jpg", "jpeg", "gif", "webp") else "image/png"
            screenshot_html = f'<p><strong>Screenshot:</strong></p><p><img src="data:{mime};base64,{b64}" style="max-width:600px;" /></p>'
            log.info(f"Screenshot embedded in ticket description ({len(file_data)} bytes)")
        except Exception as exc:
            log.warning(f"Screenshot download failed, creating ticket without it: {exc}")
            screenshot_html = "<p><strong>Screenshot:</strong> Upload failed</p>"

    description = (
        f"<p><strong>Issue:</strong> {html.escape(issue)}</p>"
        f"<p><strong>When it started:</strong> {html.escape(session.get('when_started') or 'N/A')}</p>"
        f"{screenshot_html if screenshot_html else '<p><strong>Screenshot:</strong> None provided</p>'}"
        f"<hr><p>Machine: {html.escape(hostname)}<br>Company: {html.escape(company)}<br>Room: {html.escape(room_id)}"
        f"{initiated_note}</p>"
    )

    try:
        internal_id, display_id = await create_superops_ticket(issue, description, priority, account_id)
        log_ticket(room_id)

        await _send(client, room_id,
            f"Done! Ticket #{display_id} created. A technician will follow up.\n"
            "View your ticket: https://bracer.superops.ai/portal")
        log.info(
            f"Ticket #{display_id} created - "
            f"room={room_id} host={hostname} company={company} "
            f"screenshot={'yes' if screenshot_mxc else 'no'}"
        )
    except Exception as exc:
        log.error(f"Ticket creation failed room={room_id}: {exc}")
        await _send(client, room_id,
            "Sorry, there was an error creating the ticket. "
            "Please call us at 1-888-272-2371 or email support@bracersystems.com.")


async def _handle_ticket_image(client: AsyncClient, room, room_id: str, mxc_url: str, log):
    """Handle an image message during the !ticket flow.
    Returns True if handled, False to fall through."""
    session = get_ticket_session(room_id)
    if not session:
        return False
    if session["state"] != "await_ticket_screenshot":
        return False

    await _send(client, room_id, "Got it! Creating your ticket now...")
    await _finalize_machine_ticket(client, room, room_id, session, log, screenshot_mxc=mxc_url)
    return True


def _hostname_from_room(room) -> str:
    """Parse hostname from canonical alias (#hostname:server) or fall back to room ID."""
    alias = getattr(room, "canonical_alias", None) or room.display_name or room.room_id
    if alias.startswith("#") and ":" in alias:
        return alias[1: alias.index(":")]
    return alias


def _truncate(text: str) -> str:
    """Cap user input at INPUT_MAX_LEN characters."""
    return text[:INPUT_MAX_LEN] if len(text) > INPUT_MAX_LEN else text


async def _get_room_client_displayname(client: AsyncClient, room_id: str) -> str | None:
    """Return the display name of the non-staff, non-bot user in the support room."""
    try:
        resp = await client.joined_members(room_id)
        if not isinstance(resp, JoinedMembersResponse):
            return None
        for user_id, member_info in resp.members.items():
            if user_id == BOT_USER_ID or user_id in STAFF_USERS:
                continue
            return member_info.display_name or user_id.split(":")[0].lstrip("@")
    except Exception:
        return None


async def _handle_staff_ticket_trigger(
    client: AsyncClient, room, room_id: str, sender: str, log
):
    """Handle !ticket command from a staff user - start the ticket flow addressing the client."""
    if count_recent_tickets(room_id) >= TICKET_RATE_LIMIT:
        await _send(client, room_id,
            "Rate limit reached for this room. Please open a ticket manually in SuperOps.")
        return
    client_name = await _get_room_client_displayname(client, room_id)
    name_part = f" {client_name}," if client_name else ""
    set_ticket_session(room_id, "await_issue", staff_triggered=True, initiating_staff=sender)
    await _send(client, room_id,
        f"I'll help create a ticket.{name_part} Can you describe the issue?")
    log.info(f"Staff-triggered !ticket started room={room_id} staff={sender}")


# ── Message handler ────────────────────────────────────────────────────────────

startup_ts: int = 0  # milliseconds - set in main() before sync


async def on_message(client: AsyncClient, room, event: RoomMessageText):
    # Skip backlog (events received before bot started)
    if event.server_timestamp < startup_ts:
        return

    sender  = event.sender
    room_id = room.room_id
    body    = _truncate(event.body.strip())
    log     = logging.getLogger("bracer-bot")

    # ── Autoresponder: check idle time BEFORE recording this message ──────────
    is_from_customer = (sender != BOT_USER_ID and sender not in STAFF_USERS)
    should_autorespond = is_from_customer and _should_autorespond(room_id)

    # Record activity for ALL senders (staff, bot, customers) so idle tracking works
    _record_room_activity(room_id)

    # Ignore self
    if sender == BOT_USER_ID:
        return

    # Staff: can trigger !ticket, !cancel, or advance a staff-triggered session
    if sender in STAFF_USERS:
        if body.lower() == "!ticket":
            await _handle_staff_ticket_trigger(client, room, room_id, sender, log)
            return
        if body.lower().strip() == "!cancel":
            _cancel_session = get_ticket_session(room_id)
            if _cancel_session:
                clear_ticket_session(room_id)
                await _send(client, room_id, "Ticket cancelled.")
            return
        _st_session = get_ticket_session(room_id)
        if not (_st_session and _st_session.get("staff_triggered")):
            return
        # Fall through to session handling below for staff-triggered sessions

    # Send autoresponder if room was idle long enough (non-staff only)
    if should_autorespond:
        msg = _get_autoresponder_message()
        if msg:
            await _send(client, room_id, msg)
            _record_room_activity(room_id)  # count the bot's reply as activity
            log.info(f"Autoresponder sent room={room_id} sender={sender}")

    is_guest = _is_guest_sender(sender)

    # ── Guest after-hours contact flow ─────────────────────────────────────────
    if is_guest:
        handled = await _handle_guest_afterhours(client, room, room_id, body, log)
        if handled:
            return

    # ── Active ticket session ──────────────────────────────────────────────────
    session = get_ticket_session(room_id)
    if session:
        if body.lower().strip() == "!cancel":
            clear_ticket_session(room_id)
            await _send(client, room_id, "Ticket cancelled.")
            return

        if session["state"] == "await_issue":
            set_ticket_session(room_id, "await_when", issue=body)
            await _send(client, room_id,
                "When did this start?")
            return

        if session["state"] == "await_when":
            set_ticket_session(room_id, "await_ticket_screenshot_yn",
                issue=session["issue"], when_started=body)
            await _send(client, room_id,
                "Can you send a screenshot of the issue? (yes/no)")
            return

        if session["state"] == "await_ticket_screenshot_yn":
            answer = body.lower().strip()
            if answer in ("yes", "y", "yeah", "yep", "sure"):
                set_ticket_session(room_id, "await_ticket_screenshot",
                    issue=session["issue"], when_started=session["when_started"])
                await _send(client, room_id,
                    "Please paste or attach your screenshot now.")
                return
            elif answer in ("no", "n", "nope", "nah"):
                return await _finalize_machine_ticket(
                    client, room, room_id, session, log)
            else:
                await _send(client, room_id, "Please reply yes or no.")
                return

        if session["state"] == "await_ticket_screenshot":
            if body.lower().strip() in ("skip", "no", "none"):
                return await _finalize_machine_ticket(
                    client, room, room_id, session, log)
            await _send(client, room_id,
                "I'm waiting for a screenshot image. Please paste or attach it, "
                "or type 'skip' to create the ticket without one.")
            return

    # ── !ticket command ────────────────────────────────────────────────────────
    if body.lower() == "!ticket":
        if count_recent_tickets(room_id) >= TICKET_RATE_LIMIT:
            await _send(client, room_id,
                "You've opened several tickets recently. "
                "If this is urgent please call us at 1-888-272-2371.")
            return
        set_ticket_session(room_id, "await_issue")
        await _send(client, room_id, "What's the issue you're experiencing?")
        return

    # ── Greeting (once per room) ───────────────────────────────────────────────
    if not has_greeted(room_id):
        if is_guest:
            mark_greeted(room_id, None)
            if is_business_hours():
                log.info(f"Guest greeted (business hours) room={room_id}")
                await _send(client, room_id, GUEST_GREETING_BUSINESS)
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
                await _send(client, room_id, greeting)
        else:
            hostname = _hostname_from_room(room)
            company  = None
            try:
                company = await _get_company_name(hostname)
            except Exception as exc:
                log.warning(f"Company lookup failed room={room_id}: {exc}")
            mark_greeted(room_id, company)
            log.info(f"Greeted room={room_id} host={hostname} company={company}")
            greeting = GREETING_BUSINESS if is_business_hours() else GREETING_AFTERHOURS
            await _send(client, room_id, greeting)


async def on_image(client: AsyncClient, room, event: RoomMessageImage):
    """Handle image messages - used for screenshot capture during ticket flows."""
    if event.server_timestamp < startup_ts:
        return

    sender  = event.sender
    room_id = room.room_id
    log     = logging.getLogger("bracer-bot")

    _record_room_activity(room_id)

    if sender == BOT_USER_ID:
        return

    mxc_url = event.url
    if not mxc_url:
        return

    # Staff: allow screenshots only in staff-triggered sessions
    if sender in STAFF_USERS:
        _st_session = get_ticket_session(room_id)
        if _st_session and _st_session.get("staff_triggered"):
            await _handle_ticket_image(client, room, room_id, mxc_url, log)
        return

    is_guest = _is_guest_sender(sender)

    if is_guest:
        handled = await _handle_guest_image(client, room, room_id, mxc_url, log)
        if handled:
            return

    handled = await _handle_ticket_image(client, room, room_id, mxc_url, log)
    if handled:
        return


# ── Entry point ────────────────────────────────────────────────────────────────

async def main():
    global startup_ts
    startup_ts = int(datetime.now(timezone.utc).timestamp() * 1000)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
    log = logging.getLogger("bracer-bot")

    init_db()

    config = AsyncClientConfig(
        max_limit_exceeded=0,
        max_timeouts=0,
        store_sync_tokens=False,
    )
    client = AsyncClient(MATRIX_HOMESERVER, BOT_USER_ID, config=config)
    client.device_id = "BRACER_BOT"

    resp = await client.login(BOT_PASSWORD, device_name="BRACER_BOT")
    if not isinstance(resp, LoginResponse):
        log.error(f"Login failed: {resp}")
        await client.close()
        return

    log.info(f"Logged in as {BOT_USER_ID}")

    client.add_event_callback(
        lambda room, event: asyncio.ensure_future(on_message(client, room, event)),
        RoomMessageText,
    )
    client.add_event_callback(
        lambda room, event: asyncio.ensure_future(on_image(client, room, event)),
        RoomMessageImage,
    )

    async def on_sync(resp):
        for room_id in list(client.invited_rooms.keys()):
            if not await _is_bracer_room(room_id):
                log.warning(f"Rejecting invite to {room_id} - not a bracer-register room")
                await client.room_leave(room_id)
                continue
            log.info(f"Auto-joining invited room: {room_id}")
            await client.join(room_id)

    client.add_response_callback(on_sync, SyncResponse)

    log.info("Sync loop starting...")
    try:
        await client.sync_forever(timeout=30_000, full_state=True)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
