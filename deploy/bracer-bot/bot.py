#!/usr/bin/env python3
"""
bracer-bot — Bracer Systems support bot for Matrix chat.

Phase 5 of Bracer Chat project.
Python + matrix-nio (async), systemd service on chat-bracer-ca.

Behaviour:
  - Greets on first client message per room (business-hours-aware)
  - !ticket → SuperOps ticket flow (5 questions + priority, 10-min timeout)
  - Never responds to staff or itself
  - Only joins rooms created by bracer-register
"""

import asyncio
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import aiohttp
from nio import AsyncClient, AsyncClientConfig, LoginResponse, RoomMessageText, SyncResponse

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
        # Migrations for existing DBs
        try:
            conn.execute("ALTER TABLE greeted_rooms ADD COLUMN company TEXT")
        except sqlite3.OperationalError:
            pass
        for col in ("tried TEXT", "reproduce TEXT", "when_started TEXT"):
            try:
                conn.execute(f"ALTER TABLE ticket_sessions ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass

    # Restrict DB permissions — no world-read
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
            "SELECT state, issue, tried, reproduce, when_started, last_activity "
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
        "state":        row["state"],
        "issue":        row["issue"],
        "tried":        row["tried"],
        "reproduce":    row["reproduce"],
        "when_started": row["when_started"],
    }


def set_ticket_session(
    room_id: str,
    state: str,
    issue: str = None,
    tried: str = None,
    reproduce: str = None,
    when_started: str = None,
):
    with _db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO ticket_sessions "
            "(room_id, state, issue, tried, reproduce, when_started, last_activity) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room_id, state, issue, tried, reproduce, when_started, _now()),
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Business hours ─────────────────────────────────────────────────────────────

def is_business_hours() -> bool:
    now = datetime.now(TIMEZONE)
    return now.weekday() < 5 and 8 <= now.hour < 17


# ── Synapse admin ──────────────────────────────────────────────────────────────

async def _is_bracer_room(room_id: str) -> bool:
    """Verify room was created by @bracer-register before the bot joins."""
    if not SYNAPSE_ADMIN_TOKEN:
        # No admin token — fall back to joining (safe enough with registration disabled)
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
    # Exact match first
    for client in clients:
        if (client.get("name") or "").lower() == name_lower:
            return client["accountId"]
    # Partial match: room name is substring of SuperOps name or vice versa
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
) -> str:
    """GraphQL mutation to create a SuperOps ticket. Returns displayId string."""
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
    return str(ticket.get("displayId") or ticket.get("ticketId") or "?")


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _send(client: AsyncClient, room_id: str, text: str):
    await client.room_send(
        room_id=room_id,
        message_type="m.room.message",
        content={"msgtype": "m.text", "body": text},
    )


def _hostname_from_room(room) -> str:
    """Parse hostname from canonical alias (#hostname:server) or fall back to room ID."""
    alias = getattr(room, "canonical_alias", None) or room.display_name or room.room_id
    if alias.startswith("#") and ":" in alias:
        return alias[1: alias.index(":")]
    return alias


def _truncate(text: str) -> str:
    """Cap user input at INPUT_MAX_LEN characters."""
    return text[:INPUT_MAX_LEN] if len(text) > INPUT_MAX_LEN else text


# ── Message handler ────────────────────────────────────────────────────────────

startup_ts: int = 0  # milliseconds — set in main() before sync


async def on_message(client: AsyncClient, room, event: RoomMessageText):
    # Skip backlog (events received before bot started)
    if event.server_timestamp < startup_ts:
        return

    sender  = event.sender
    room_id = room.room_id
    body    = _truncate(event.body.strip())
    log     = logging.getLogger("bracer-bot")

    # Ignore self and staff
    if sender == BOT_USER_ID or sender in STAFF_USERS:
        return

    # ── Active ticket session ──────────────────────────────────────────────────
    session = get_ticket_session(room_id)
    if session:
        if session["state"] == "await_issue":
            set_ticket_session(room_id, "await_tried", issue=body)
            await _send(client, room_id,
                "What have you already tried to fix it?")
            return

        if session["state"] == "await_tried":
            set_ticket_session(room_id, "await_reproduce",
                issue=session["issue"], tried=body)
            await _send(client, room_id,
                "How would we reproduce this? Step by step if possible.")
            return

        if session["state"] == "await_reproduce":
            set_ticket_session(room_id, "await_when",
                issue=session["issue"], tried=session["tried"], reproduce=body)
            await _send(client, room_id,
                "When did this start, and has anything changed on the machine recently? "
                "(e.g. updates, new software, hardware changes)")
            return

        if session["state"] == "await_when":
            set_ticket_session(room_id, "await_priority",
                issue=session["issue"], tried=session["tried"],
                reproduce=session["reproduce"], when_started=body)
            await _send(client, room_id,
                "Last question — how urgent is this?\n1 = Low\n2 = Normal\n3 = High")
            return

        if session["state"] == "await_priority":
            if body not in ("1", "2", "3"):
                set_ticket_session(room_id, "await_priority",
                    issue=session["issue"], tried=session["tried"],
                    reproduce=session["reproduce"], when_started=session["when_started"])
                await _send(client, room_id,
                    "Please reply with 1 (Low), 2 (Normal), or 3 (High).")
                return

            issue    = session["issue"]
            priority = PRIORITY_MAP[body]
            hostname = _hostname_from_room(room)
            company  = get_company(room_id)
            clear_ticket_session(room_id)

            # Company: use cached value, fall back to live lookup
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

            description = (
                f"Issue: {issue}\n\n"
                f"What was tried: {session['tried'] or 'N/A'}\n\n"
                f"How to reproduce: {session['reproduce'] or 'N/A'}\n\n"
                f"When it started / recent changes: {session['when_started'] or 'N/A'}\n\n"
                f"---\nMachine: {hostname}\nCompany: {company}\nRoom: {room_id}"
            )

            try:
                ticket_id = await create_superops_ticket(issue, description, priority, account_id)
                log_ticket(room_id)
                await _send(client, room_id,
                    f"Done! Ticket #{ticket_id} created. A technician will follow up.\n"
                    "View your ticket: https://bracer.superops.ai/portal")
                log.info(
                    f"Ticket #{ticket_id} created — "
                    f"room={room_id} host={hostname} company={company}"
                )
            except Exception as exc:
                log.error(f"Ticket creation failed room={room_id}: {exc}")
                await _send(client, room_id,
                    "Sorry, there was an error creating the ticket. "
                    "Please call us at 1-888-272-2371 or email support@bracersystems.com.")
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


# ── Entry point ────────────────────────────────────────────────────────────────

async def main():
    global startup_ts
    startup_ts = int(datetime.now(timezone.utc).timestamp() * 1000)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
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

    async def on_sync(resp):
        for room_id in list(client.invited_rooms.keys()):
            if not await _is_bracer_room(room_id):
                log.warning(f"Rejecting invite to {room_id} — not a bracer-register room")
                await client.room_leave(room_id)
                continue
            log.info(f"Auto-joining invited room: {room_id}")
            await client.join(room_id)

    client.add_response_callback(on_sync, SyncResponse)

    log.info("Sync loop starting…")
    try:
        await client.sync_forever(timeout=30_000, full_state=True)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
