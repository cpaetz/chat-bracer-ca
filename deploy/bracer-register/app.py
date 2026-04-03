import re
import sqlite3
import subprocess
import tempfile
import secrets
import string
import logging
import os
import time
import asyncio
from collections import defaultdict
from urllib.parse import quote as urlquote, urlencode
from pathlib import Path

import httpx
import json

from fastapi import FastAPI, HTTPException, Request, Depends, Cookie, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse, HTMLResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, validator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# CORS for website chat widget (bracer.ca embedding chat.bracer.ca)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://bracer.ca", "https://www.bracer.ca"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)

RC_URL = os.environ.get("RC_URL", "http://localhost:3000")
RC_ADMIN_TOKEN = os.environ["RC_ADMIN_TOKEN"]
RC_ADMIN_USER_ID = os.environ["RC_ADMIN_USER_ID"]
API_SECRET = os.environ["API_SECRET"]
SERVER_NAME = os.environ.get("SERVER_NAME", "chat.bracer.ca")
BROADCAST_CHANNEL = os.environ.get("BROADCAST_CHANNEL", "bracer-broadcast")
SUPEROPS_API_KEY   = os.environ["SUPEROPS_API_KEY"]
SUPEROPS_SUBDOMAIN = "bracer"

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = f"https://{SERVER_NAME}/api/admin/callback"

STAFF_USERNAMES = ["chris.paetz", "teri.sauve"]
STAFF_EMAIL_MAP = {
    "cpaetz@bracer.ca": "chris.paetz",
    "chris.paetz@bracersystems.net": "chris.paetz",
    "teri@bracer.ca": "teri.sauve",
}
BOT_USERNAME = "bracerbot"

RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_COOLDOWN = 1800  # 30 minutes cooldown after hitting limit
RATE_LIMIT_AUTH_MAX = 60    # Higher limit for authenticated endpoints (update/logs)
RATE_LIMIT_AUTH_WINDOW = 300  # 5-minute window for auth endpoints
RATE_LIMIT_MAX_IPS = 10000  # Max tracked IPs before forced cleanup
_rate_store: dict = defaultdict(list)
_rate_store_auth: dict = defaultdict(list)  # Separate store for authenticated endpoints
_rate_cooldown: dict = {}  # ip -> cooldown_expires_at
_rate_lock = asyncio.Lock()
_rate_last_cleanup = 0.0  # monotonic timestamp of last cleanup
RATE_CLEANUP_INTERVAL = 300  # cleanup stale entries every 5 min

# Endpoints that are public-facing and need tight rate limits
_PUBLIC_RATE_PATHS = {"/api/register", "/api/companies", "/api/installer/claim", "/api/guest/start", "/api/machine/reauth"}
# Endpoints that are authenticated and can have higher limits
_AUTH_RATE_PREFIXES = ("/api/update/", "/api/logs/", "/api/guest/heartbeat")

# Auth failure tracking for helpdesk alerting
AUTH_FAIL_THRESHOLD = 10      # failures per window before alerting
AUTH_FAIL_WINDOW    = 300     # 5-minute window
AUTH_FAIL_MAX_IPS   = 5000    # Max tracked IPs before forced cleanup
_auth_fail_store: dict = defaultdict(list)
_auth_fail_alerted: dict = {}  # ip -> last alert time

security = HTTPBearer()


def slugify(name: str) -> str:
    slug = name.lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = slug.strip("-")
    return slug[:32]


def generate_password(length: int = 40) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> None:
    if not secrets.compare_digest(credentials.credentials.encode(), API_SECRET.encode()):
        logger.warning("Invalid API token")
        raise HTTPException(status_code=401, detail="Unauthorized")


def _rc_admin_headers() -> dict:
    """Return Rocket.Chat admin auth headers."""
    return {
        "X-Auth-Token": RC_ADMIN_TOKEN,
        "X-User-Id": RC_ADMIN_USER_ID,
        "Content-Type": "application/json",
    }


def _rc_user_headers(auth_token: str, user_id: str) -> dict:
    """Return Rocket.Chat auth headers for a specific user."""
    return {
        "X-Auth-Token": auth_token,
        "X-User-Id": user_id,
        "Content-Type": "application/json",
    }


async def _rc_get_user(client: httpx.AsyncClient, username: str) -> dict | None:
    """Look up a Rocket.Chat user by username. Returns user dict or None."""
    resp = await client.get(
        f"{RC_URL}/api/v1/users.info",
        headers=_rc_admin_headers(),
        params={"username": username},
    )
    if resp.status_code == 200:
        data = resp.json()
        if data.get("success"):
            return data.get("user")
    return None


async def _rc_find_machine_user(client: httpx.AsyncClient, hostname: str) -> dict | None:
    """Find a machine user by hostname. Handles both old (hostname) and new
    (hostname.user) username formats. Returns user dict or None."""
    # Try exact hostname first (old format)
    user = await _rc_get_user(client, hostname)
    if user:
        return user
    # Search for hostname.* pattern (new format)
    resp = await client.get(
        f"{RC_URL}/api/v1/users.list",
        headers=_rc_admin_headers(),
        params={"count": 10, "query": hostname},
    )
    if resp.status_code == 200 and resp.json().get("success"):
        for u in resp.json().get("users", []):
            uname = u.get("username", "")
            # Match hostname_something or hostname.something (legacy)
            if uname == hostname or uname.startswith(f"{hostname}_") or uname.startswith(f"{hostname}."):
                return u
    return None


async def _rc_create_user(
    client: httpx.AsyncClient,
    username: str,
    password: str,
    name: str,
    roles: list[str] | None = None,
) -> dict:
    """Create a Rocket.Chat user. Returns user dict."""
    payload = {
        "username": username,
        "password": password,
        "name": name,
        "email": f"{username}@machine.bracer.ca",
        "verified": True,
        "requirePasswordChange": False,
    }
    if roles:
        payload["roles"] = roles
    resp = await client.post(
        f"{RC_URL}/api/v1/users.create",
        headers=_rc_admin_headers(),
        json=payload,
    )
    if resp.status_code != 200 or not resp.json().get("success"):
        logger.error(f"Failed to create user {username}: {resp.status_code} {resp.text[:300]}")
        raise HTTPException(status_code=500, detail="Failed to create user")
    return resp.json()["user"]


async def _rc_update_user(
    client: httpx.AsyncClient,
    user_id: str,
    **fields,
) -> dict:
    """Update a Rocket.Chat user. Returns user dict."""
    resp = await client.post(
        f"{RC_URL}/api/v1/users.update",
        headers=_rc_admin_headers(),
        json={"userId": user_id, "data": fields},
    )
    if resp.status_code != 200 or not resp.json().get("success"):
        logger.error(f"Failed to update user {user_id}: {resp.status_code} {resp.text[:300]}")
        raise HTTPException(status_code=500, detail="Failed to update user")
    return resp.json()["user"]


async def _rc_login(client: httpx.AsyncClient, username: str, password: str) -> dict:
    """Log in to Rocket.Chat. Returns {authToken, userId}."""
    resp = await client.post(
        f"{RC_URL}/api/v1/login",
        json={"user": username, "password": password},
    )
    if resp.status_code != 200 or not resp.json().get("status") == "success":
        logger.error(f"Login failed for {username}: {resp.status_code} {resp.text[:300]}")
        raise HTTPException(status_code=500, detail="Login failed")
    data = resp.json()["data"]
    return {"authToken": data["authToken"], "userId": data["userId"]}


async def _rc_get_room(client: httpx.AsyncClient, room_name: str, room_type: str = "c") -> dict | None:
    """Look up a Rocket.Chat room by name. room_type: 'c' for channel, 'p' for group.
    Returns room dict or None."""
    endpoint = "channels.info" if room_type == "c" else "groups.info"
    resp = await client.get(
        f"{RC_URL}/api/v1/{endpoint}",
        headers=_rc_admin_headers(),
        params={"roomName": room_name},
    )
    if resp.status_code == 200:
        data = resp.json()
        if data.get("success"):
            return data.get("channel") or data.get("group")
    return None


async def _rc_create_channel(
    client: httpx.AsyncClient,
    name: str,
    members: list[str] | None = None,
    read_only: bool = False,
) -> dict:
    """Create a Rocket.Chat channel (public). Returns channel dict."""
    payload = {"name": name, "readOnly": read_only}
    if members:
        payload["members"] = members
    resp = await client.post(
        f"{RC_URL}/api/v1/channels.create",
        headers=_rc_admin_headers(),
        json=payload,
    )
    if resp.status_code != 200 or not resp.json().get("success"):
        logger.error(f"Failed to create channel {name}: {resp.status_code} {resp.text[:300]}")
        raise HTTPException(status_code=500, detail="Failed to create channel")
    return resp.json()["channel"]


async def _rc_create_group(
    client: httpx.AsyncClient,
    name: str,
    members: list[str] | None = None,
    read_only: bool = False,
) -> dict:
    """Create a Rocket.Chat group (private). Returns group dict."""
    payload = {"name": name, "readOnly": read_only}
    if members:
        payload["members"] = members
    resp = await client.post(
        f"{RC_URL}/api/v1/groups.create",
        headers=_rc_admin_headers(),
        json=payload,
    )
    if resp.status_code != 200 or not resp.json().get("success"):
        logger.error(f"Failed to create group {name}: {resp.status_code} {resp.text[:300]}")
        raise HTTPException(status_code=500, detail="Failed to create group")
    return resp.json()["group"]


async def _rc_invite_to_room(
    client: httpx.AsyncClient,
    room_id: str,
    user_id: str,
    room_type: str = "c",
) -> bool:
    """Invite a user to a room. Returns True on success."""
    endpoint = "channels.invite" if room_type == "c" else "groups.invite"
    resp = await client.post(
        f"{RC_URL}/api/v1/{endpoint}",
        headers=_rc_admin_headers(),
        json={"roomId": room_id, "userId": user_id},
    )
    if resp.status_code == 200 and resp.json().get("success"):
        return True
    # May already be a member — not an error
    if "already" in resp.text.lower():
        return True
    logger.warning(f"Invite failed: room={room_id} user={user_id}: {resp.text[:200]}")
    return False


async def _rc_set_moderator(
    client: httpx.AsyncClient,
    room_id: str,
    user_id: str,
    room_type: str = "c",
) -> bool:
    """Set a user as moderator in a room."""
    endpoint = "channels.addModerator" if room_type == "c" else "groups.addModerator"
    resp = await client.post(
        f"{RC_URL}/api/v1/{endpoint}",
        headers=_rc_admin_headers(),
        json={"roomId": room_id, "userId": user_id},
    )
    return resp.status_code == 200 and resp.json().get("success", False)


async def _rc_post_message(
    client: httpx.AsyncClient,
    room_id: str,
    text: str,
    auth_token: str | None = None,
    user_id: str | None = None,
) -> bool:
    """Send a message to a room. Uses admin headers if no user auth provided."""
    headers = _rc_user_headers(auth_token, user_id) if auth_token else _rc_admin_headers()
    resp = await client.post(
        f"{RC_URL}/api/v1/chat.postMessage",
        headers=headers,
        json={"roomId": room_id, "text": text},
    )
    return resp.status_code == 200 and resp.json().get("success", False)


class RegisterRequest(BaseModel):
    hostname: str
    company: str
    elevated: bool = False  # If True, machine account gets power level 50 in company broadcast
    logged_in_user: str = ""  # Windows username for display name, e.g. "chris.paetz"

    @validator("hostname")
    def validate_hostname(cls, v):
        if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,62}[a-zA-Z0-9])?$", v):
            raise ValueError("Invalid hostname")
        return v.lower()

    @validator("company")
    def validate_company(cls, v):
        v = v.strip()
        if not (1 <= len(v) <= 128):
            raise ValueError("Company name must be 1-128 characters")
        return v

    @validator("logged_in_user")
    def validate_logged_in_user(cls, v):
        v = v.strip()
        if v and len(v) > 128:
            raise ValueError("logged_in_user must be <= 128 characters")
        return v


def _strip_domain(logged_in_user: str) -> str:
    """Strip DOMAIN\\ prefix if present (e.g. 'BRACER\\chris.paetz' -> 'chris.paetz')."""
    return logged_in_user.split("\\")[-1] if "\\" in logged_in_user else logged_in_user


def _build_display_name(hostname: str, logged_in_user: str = "") -> str:
    """Build RC display name: 'HOSTNAME (user)' or just 'HOSTNAME'."""
    if logged_in_user:
        user = _strip_domain(logged_in_user)
        return f"{hostname.upper()} ({user})"
    return hostname.upper()


def _build_username(hostname: str, logged_in_user: str = "") -> str:
    """Build RC username: 'hostname_user' or just 'hostname'.
    RC usernames must be lowercase, no spaces, no parens.
    Underscore separates hostname from user since hostnames use hyphens
    and Windows usernames may contain dots."""
    if logged_in_user:
        user = _strip_domain(logged_in_user).lower()
        return f"{hostname.lower()}_{user}"
    return hostname.lower()


ALLOWED_ORIGINS = {"https://bracer.ca", "https://www.bracer.ca"}


@app.middleware("http")
async def guest_origin_check(request: Request, call_next):
    """Validate Origin header on guest chat endpoints only."""
    if request.url.path.startswith("/api/guest/"):
        # Allow CORS preflight through
        if request.method == "OPTIONS":
            return await call_next(request)
        origin = request.headers.get("origin", "").lower()
        if origin not in ALLOWED_ORIGINS:
            logger.warning(f"Guest endpoint blocked: origin={origin!r} path={request.url.path} ip={request.client.host}")
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    return await call_next(request)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/"):
        ip = request.client.host
        now = time.monotonic()
        async with _rate_lock:
            # Periodic cleanup of stale entries to prevent unbounded dict growth
            global _rate_last_cleanup
            if now - _rate_last_cleanup > RATE_CLEANUP_INTERVAL or len(_rate_store) > RATE_LIMIT_MAX_IPS:
                _rate_store.update({k: [t for t in v if now - t < RATE_LIMIT_WINDOW] for k, v in _rate_store.items()})
                for k in [k for k, v in _rate_store.items() if not v]:
                    del _rate_store[k]
                _rate_store_auth.update({k: [t for t in v if now - t < RATE_LIMIT_AUTH_WINDOW] for k, v in _rate_store_auth.items()})
                for k in [k for k, v in _rate_store_auth.items() if not v]:
                    del _rate_store_auth[k]
                for k in [k for k, v in _rate_cooldown.items() if now > v]:
                    del _rate_cooldown[k]
                _rate_last_cleanup = now

            # Tiered rate limiting:
            # - Public endpoints (register, guest/start, etc.): 5/min + 30-min cooldown
            # - Authenticated endpoints (update, logs, heartbeat): 60/5min, no cooldown
            if path in _PUBLIC_RATE_PATHS:
                # Check cooldown first
                if ip in _rate_cooldown and now < _rate_cooldown[ip]:
                    retry_after = int(_rate_cooldown[ip] - now)
                    logger.warning(f"Rate limit cooldown active for {ip} ({retry_after}s remaining)")
                    return JSONResponse(
                        status_code=429,
                        content={"detail": "Too many requests", "retry_after": retry_after},
                        headers={"Retry-After": str(retry_after)},
                    )
                _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_LIMIT_WINDOW]
                if len(_rate_store[ip]) >= RATE_LIMIT_MAX:
                    _rate_cooldown[ip] = now + RATE_LIMIT_COOLDOWN
                    logger.warning(f"Rate limit exceeded for {ip} — 30 min cooldown started")
                    return JSONResponse(
                        status_code=429,
                        content={"detail": "Too many requests", "retry_after": RATE_LIMIT_COOLDOWN},
                        headers={"Retry-After": str(RATE_LIMIT_COOLDOWN)},
                    )
                _rate_store[ip].append(now)

            elif any(path.startswith(p) for p in _AUTH_RATE_PREFIXES):
                # Higher limit for authenticated machine endpoints
                _rate_store_auth[ip] = [t for t in _rate_store_auth[ip] if now - t < RATE_LIMIT_AUTH_WINDOW]
                if len(_rate_store_auth[ip]) >= RATE_LIMIT_AUTH_MAX:
                    logger.warning(f"Auth rate limit exceeded for {ip}")
                    return JSONResponse(
                        status_code=429,
                        content={"detail": "Too many requests", "retry_after": 60},
                        headers={"Retry-After": "60"},
                    )
                _rate_store_auth[ip].append(now)

    return await call_next(request)


@app.get("/health")
async def health():
    return {"status": "ok"}



@app.get("/api/companies")
async def list_companies(_: None = Depends(verify_token)):
    query = "{  getClientList(input: { page: 1, pageSize: 200 }) { clients { name stage } } }"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://api.superops.ai/msp",
            headers={
                "authorization": f"Bearer {SUPEROPS_API_KEY}",
                "CustomerSubDomain": SUPEROPS_SUBDOMAIN,
                "Content-Type": "application/json",
            },
            json={"query": query},
        )
    if resp.status_code != 200:
        logger.error(f"SuperOps API error: {resp.status_code} {resp.text[:200]}")
        raise HTTPException(status_code=502, detail="Could not fetch companies from SuperOps")
    data = resp.json()
    clients = (data.get("data") or {}).get("getClientList", {}).get("clients", [])
    active = sorted(
        [cl["name"] for cl in clients if (cl.get("stage") or "").lower() == "active"],
        key=str.casefold,
    )
    return {"companies": active}


@app.post("/api/register")
async def register(
    request: Request,
    body: RegisterRequest,
    _: None = Depends(verify_token),
):
    hostname = body.hostname
    company = body.company
    company_slug = slugify(company)
    elevated = body.elevated
    display_name = _build_display_name(hostname, body.logged_in_user)
    new_username = _build_username(hostname, body.logged_in_user)

    logger.info(f"Registration: hostname={hostname} company={company} elevated={elevated} display={display_name} username={new_username} ip={request.client.host}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Create or update RC user
        password = generate_password()
        existing = await _rc_find_machine_user(client, hostname)
        if existing:
            rc_user = await _rc_update_user(client, existing["_id"], password=password, active=True, name=display_name, username=new_username)
        else:
            rc_user = await _rc_create_user(client, new_username, password, name=display_name)

        rc_user_id = rc_user["_id"]

        # 2. Log in as the new user to get auth token
        login = await _rc_login(client, new_username, password)
        auth_token = login["authToken"]

        # 3. Get or create broadcast channel and invite user
        broadcast = await _rc_get_room(client, BROADCAST_CHANNEL, room_type="c")
        if not broadcast:
            broadcast = await _rc_create_channel(client, BROADCAST_CHANNEL, members=STAFF_USERNAMES + [BOT_USERNAME])
        broadcast_id = broadcast["_id"]
        await _rc_invite_to_room(client, broadcast_id, rc_user_id, room_type="c")

        # 4. Get or create company broadcast channel and invite user
        company_room_id = await _get_or_create_company_room(client, company, company_slug)
        await _rc_invite_to_room(client, company_room_id, rc_user_id, room_type="c")

        # 4b. If elevated, make moderator in company broadcast
        if elevated:
            if await _rc_set_moderator(client, company_room_id, rc_user_id, room_type="c"):
                logger.info(f"Set {hostname} as moderator in company broadcast {company_room_id}")

        # 5. Get or create machine room
        machine_room_id = await _get_or_create_machine_room(client, hostname, rc_user_id)

    logger.info(
        f"Complete: {hostname} broadcast={broadcast_id} "
        f"company={company_room_id} machine={machine_room_id}"
    )

    return {
        "user_id": rc_user_id,
        "username": new_username,
        "auth_token": auth_token,
        "elevated": elevated,
        "rooms": {
            "broadcast": broadcast_id,
            "company_broadcast": company_room_id,
            "machine": machine_room_id,
        },
    }


async def _get_or_create_company_room(
    client: httpx.AsyncClient,
    company: str,
    company_slug: str,
) -> str:
    """Get or create the company broadcast channel. Returns room_id."""
    room_name = f"company-{company_slug}-broadcast"

    # Check if channel already exists
    room = await _rc_get_room(client, room_name, room_type="c")
    if room:
        return room["_id"]

    # Create channel with staff as initial members
    channel = await _rc_create_channel(
        client,
        name=room_name,
        members=STAFF_USERNAMES + [BOT_USERNAME],
        read_only=False,
    )
    room_id = channel["_id"]

    # Set topic and announcement
    await client.post(
        f"{RC_URL}/api/v1/channels.setTopic",
        headers=_rc_admin_headers(),
        json={"roomId": room_id, "topic": f"Announcements from Bracer Systems for {company}."},
    )
    await client.post(
        f"{RC_URL}/api/v1/channels.setDescription",
        headers=_rc_admin_headers(),
        json={"roomId": room_id, "description": f"{company} \u2014 Bracer Announcements"},
    )

    logger.info(f"Created company broadcast channel: {room_name} -> {room_id}")
    return room_id


async def _get_or_create_machine_room(
    client: httpx.AsyncClient,
    hostname: str,
    machine_user_id: str,
) -> str:
    """Get or create the private machine support group. Returns room_id."""
    room_name = hostname

    # Check if group already exists
    room = await _rc_get_room(client, room_name, room_type="p")
    if room:
        return room["_id"]

    # Create private group with staff + bot as members
    group = await _rc_create_group(
        client,
        name=room_name,
        members=STAFF_USERNAMES + [BOT_USERNAME],
        read_only=False,
    )
    room_id = group["_id"]

    # Set topic
    await client.post(
        f"{RC_URL}/api/v1/groups.setTopic",
        headers=_rc_admin_headers(),
        json={"roomId": room_id, "topic": "Bracer Systems support channel for this machine."},
    )

    # Invite the machine user
    await _rc_invite_to_room(client, room_id, machine_user_id, room_type="p")

    logger.info(f"Created machine support group: {room_name} -> {room_id}")
    return room_id


# ── Installer Generator ────────────────────────────────────────────────────────

INSTALLER_DB       = "/opt/bracer-register/installer_tokens.db"
INSTALL_EXE_PATH   = "/var/www/install/BracerChat-Setup-latest.exe"
NSIS_TEMPLATE_PATH = "/opt/bracer-register/nsis_template.nsi"
PS_TEMPLATE_PATH   = "/opt/bracer-register/nsis_ps_template.ps1"


def _init_installer_db():
    db = sqlite3.connect(INSTALLER_DB)
    db.execute("""
        CREATE TABLE IF NOT EXISTS installer_tokens (
            token      TEXT PRIMARY KEY,
            company    TEXT NOT NULL,
            created_at REAL NOT NULL,
            expires_at REAL NOT NULL
        )
    """)
    db.commit()
    db.close()


_init_installer_db()


def _get_installer_token(token: str):
    db = sqlite3.connect(INSTALLER_DB)
    row = db.execute(
        "SELECT company, expires_at FROM installer_tokens WHERE token = ?", (token,)
    ).fetchone()
    db.close()
    return row


def _consume_installer_token(token: str):
    """Delete an installer token after successful claim (single-use enforcement)."""
    db = sqlite3.connect(INSTALLER_DB)
    db.execute("DELETE FROM installer_tokens WHERE token = ?", (token,))
    db.commit()
    db.close()
    logger.info(f"Installer token consumed: ...{token[-8:]}")


class InstallerGenerateRequest(BaseModel):
    company: str

    @validator("company")
    def validate_company(cls, v):
        v = v.strip()
        if not (1 <= len(v) <= 128):
            raise ValueError("Company name must be 1-128 characters")
        return v


@app.get("/api/installer/companies")
async def installer_companies():
    """Return active company list for installer UI (protected by Caddy Basic Auth)."""
    query = "{ getClientList(input: { page: 1, pageSize: 200 }) { clients { name stage } } }"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://api.superops.ai/msp",
            headers={
                "authorization": f"Bearer {SUPEROPS_API_KEY}",
                "CustomerSubDomain": SUPEROPS_SUBDOMAIN,
                "Content-Type": "application/json",
            },
            json={"query": query},
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Could not fetch companies")
    data = resp.json()
    clients = (data.get("data") or {}).get("getClientList", {}).get("clients", [])
    active = sorted(
        [cl["name"] for cl in clients if (cl.get("stage") or "").lower() == "active"],
        key=str.casefold,
    )
    return {"companies": active}


@app.post("/api/installer/generate")
async def installer_generate(body: InstallerGenerateRequest):
    """Generate a 24-hour installer token for a company (protected by Caddy Basic Auth)."""
    token = secrets.token_hex(24)
    now = time.time()
    expires = now + 86400
    db = sqlite3.connect(INSTALLER_DB)
    db.execute(
        "INSERT OR REPLACE INTO installer_tokens VALUES (?, ?, ?, ?)",
        (token, body.company, now, expires),
    )
    db.commit()
    db.close()
    logger.info(f"Installer token generated for company={body.company}")
    return {"token": token, "company": body.company, "expires_at": expires}


@app.api_route("/api/installer/claim", methods=["GET", "POST"])
async def installer_claim(request: Request, token: str = "", hostname: str = ""):
    """Validate token and register a machine. Called by the NSIS EXE on client machines.
    Accepts POST with JSON body {"token": "...", "hostname": "..."} (preferred)
    or GET with query params (deprecated — token leaks into Caddy logs)."""
    # POST with JSON body (preferred)
    logged_in_user = ""
    if request.method == "POST" and not token:
        try:
            body = await request.json()
            token = str(body.get("token", ""))
            hostname = str(body.get("hostname", ""))
            logged_in_user = str(body.get("logged_in_user", ""))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")
    elif request.method == "GET":
        logger.warning(f"DEPRECATED: /api/installer/claim called via GET (token in URL). ip={request.client.host}")

    if not token or not hostname:
        raise HTTPException(status_code=400, detail="Missing token or hostname")
    if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,62}[a-zA-Z0-9])?$", hostname):
        raise HTTPException(status_code=400, detail="Invalid hostname")
    hostname = hostname.lower()

    row = _get_installer_token(token)
    if not row:
        raise HTTPException(status_code=404, detail="Token not found")
    company, expires_at = row
    if time.time() > expires_at:
        raise HTTPException(status_code=410, detail="Token expired")

    logger.info(
        f"Installer claim: token=...{token[-8:]} hostname={hostname} "
        f"company={company} ip={request.client.host}"
    )

    company_slug = slugify(company)

    display_name = _build_display_name(hostname, logged_in_user)
    new_username = _build_username(hostname, logged_in_user)

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Create or update user
        password = generate_password()
        existing = await _rc_find_machine_user(client, hostname)
        if existing:
            await _rc_update_user(client, existing["_id"], password=password, active=True, name=display_name, username=new_username)
            rc_user_id = existing["_id"]
        else:
            rc_user = await _rc_create_user(client, new_username, password, name=display_name)
            rc_user_id = rc_user["_id"]

        # Login
        login_data = await _rc_login(client, new_username, password)
        auth_token = login_data["authToken"]

        # Broadcast channel
        broadcast = await _rc_get_room(client, BROADCAST_CHANNEL, room_type="c")
        if not broadcast:
            broadcast = await _rc_create_channel(client, BROADCAST_CHANNEL, members=STAFF_USERNAMES + [BOT_USERNAME])
        broadcast_id = broadcast["_id"]
        await _rc_invite_to_room(client, broadcast_id, rc_user_id, room_type="c")

        # Company broadcast
        company_room_id = await _get_or_create_company_room(client, company, company_slug)
        await _rc_invite_to_room(client, company_room_id, rc_user_id, room_type="c")

        # Machine room
        machine_room_id = await _get_or_create_machine_room(client, hostname, rc_user_id)

    # Invalidate token after successful claim (single-use)
    _consume_installer_token(token)

    logger.info(f"Installer claim complete: {hostname} -> {new_username}")
    return {
        "user_id": rc_user_id,
        "username": new_username,
        "auth_token": auth_token,
        "elevated": False,
        "room_id_machine": machine_room_id,
        "room_id_broadcast": broadcast_id,
        "room_id_company": company_room_id,
    }


@app.api_route("/api/installer/app", methods=["GET", "POST"])
async def installer_app(request: Request, token: str = ""):
    """Stream the BracerChat installer EXE. Called by the NSIS EXE on client machines.
    Accepts POST with JSON body {"token": "..."} (preferred)
    or GET with query param (deprecated)."""
    if request.method == "POST" and not token:
        try:
            body = await request.json()
            token = str(body.get("token", ""))
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body")
    if not token:
        raise HTTPException(status_code=400, detail="Missing token")
    row = _get_installer_token(token)
    if not row:
        raise HTTPException(status_code=404, detail="Token not found")
    _, expires_at = row
    if time.time() > expires_at:
        raise HTTPException(status_code=410, detail="Token expired")

    exe_path = os.path.realpath(INSTALL_EXE_PATH)
    if not os.path.exists(exe_path):
        raise HTTPException(status_code=503, detail="Installer not available")

    exe_name = os.path.basename(exe_path)

    def iterfile():
        with open(exe_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    return StreamingResponse(
        iterfile(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={exe_name}"},
    )


@app.get("/api/installer/download")
async def installer_download(token: str):
    """Build and serve a custom NSIS EXE for this token. Called from the web UI."""
    row = _get_installer_token(token)
    if not row:
        raise HTTPException(status_code=404, detail="Token not found")
    company, expires_at = row
    if time.time() > expires_at:
        raise HTTPException(status_code=410, detail="Token expired")

    # Strict sanitisation — only allow safe chars in template substitutions
    # to prevent NSIS/PowerShell injection via company name or token
    company_safe = re.sub(r"[^a-zA-Z0-9]", "-", company).strip("-")[:40]
    company_display = re.sub(r"[^a-zA-Z0-9 &\-.,']", "", company).strip()[:128]
    token_short  = token[:12]
    exe_name     = f"BracerChatInstall-{company_safe}.exe"

    with open(NSIS_TEMPLATE_PATH) as f:
        nsi = f.read()
    with open(PS_TEMPLATE_PATH) as f:
        ps = f.read()

    ps  = ps.replace("{{TOKEN}}", token)
    nsi = nsi.replace("{{EXE_NAME}}", exe_name)
    nsi = nsi.replace("{{COMPANY}}", company_display)
    nsi = nsi.replace("{{TOKEN_SHORT}}", token_short)

    with tempfile.TemporaryDirectory() as tmpdir:
        ps_path  = os.path.join(tmpdir, "install.ps1")
        nsi_path = os.path.join(tmpdir, "installer.nsi")
        exe_path = os.path.join(tmpdir, exe_name)

        with open(ps_path,  "w") as f:
            f.write(ps)
        with open(nsi_path, "w") as f:
            f.write(nsi)

        result = subprocess.run(
            ["makensis", "-V2", nsi_path],
            capture_output=True, text=True, cwd=tmpdir,
        )
        if result.returncode != 0:
            logger.error(f"makensis failed: {result.stderr}")
            raise HTTPException(status_code=500, detail="Failed to build installer")

        exe_data = open(exe_path, "rb").read()

    logger.info(f"Installer EXE built: {exe_name} ({len(exe_data)//1024}KB) for company={company}")
    return StreamingResponse(
        iter([exe_data]),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{exe_name}"'},
    )

# ── Self-Update + Log Collection ────────────────────────────────────────────────

from datetime import datetime, timedelta

LOG_STORE_DIR = "/opt/bracer-logs"


async def _track_auth_failure(ip: str):
    """Track auth failures per IP. Opens a SuperOps ticket if threshold is crossed."""
    now = time.monotonic()
    async with _rate_lock:
        # Periodic cleanup of stale auth failure entries
        if len(_auth_fail_store) > AUTH_FAIL_MAX_IPS:
            for k in [k for k, v in _auth_fail_store.items() if not v or now - v[-1] > AUTH_FAIL_WINDOW]:
                del _auth_fail_store[k]
            for k in [k for k, v in _auth_fail_alerted.items() if now - v > 3600]:
                del _auth_fail_alerted[k]

        _auth_fail_store[ip] = [t for t in _auth_fail_store[ip] if now - t < AUTH_FAIL_WINDOW]
        _auth_fail_store[ip].append(now)
        count = len(_auth_fail_store[ip])

        if count >= AUTH_FAIL_THRESHOLD:
            last_alert = _auth_fail_alerted.get(ip, 0)
            if now - last_alert > 3600:  # max 1 alert per IP per hour
                _auth_fail_alerted[ip] = now
                logger.warning(f"Auth failure threshold crossed: ip={ip} count={count}/{AUTH_FAIL_WINDOW}s")
                try:
                    await _create_auth_alert_ticket(ip, count)
                except Exception as e:
                    logger.error(f"Failed to create auth alert ticket: {e}")


async def _create_auth_alert_ticket(ip: str, count: int):
    """Create a SuperOps ticket alerting to repeated auth failures."""
    mutation = """
    mutation CreateTicket($input: createTicketInput!) {
      createTicket(input: $input) { ticketId }
    }
    """
    variables = {
        "input": {
            "subject": f"Security Alert: Repeated auth failures from {ip}",
            "description": (
                f"<p><strong>Automated Security Alert</strong></p>"
                f"<p>IP address <code>{ip}</code> has had <strong>{count}</strong> "
                f"authentication failures in the last {AUTH_FAIL_WINDOW // 60} minutes "
                f"against the Bracer Chat API (chat.bracer.ca).</p>"
                f"<p>This may indicate a brute force attempt. Review server logs for details.</p>"
            ),
            "priority": "HIGH",
        }
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://api.superops.ai/msp",
            headers={
                "authorization": f"Bearer {SUPEROPS_API_KEY}",
                "CustomerSubDomain": SUPEROPS_SUBDOMAIN,
                "Content-Type": "application/json",
            },
            json={"query": mutation, "variables": variables},
        )
    if resp.status_code == 200:
        logger.info(f"Auth alert ticket created for IP {ip}")
    else:
        logger.error(f"Failed to create auth alert ticket: {resp.status_code} {resp.text[:200]}")


async def _validate_machine_token(request: Request, client_ip: str = "unknown"):
    """Validate machine RC auth from request headers. Returns hostname string or None.
    Expects: Authorization: Bearer <authToken>:<userId> (combined format)
    or X-Auth-Token + X-User-Id headers."""
    auth_token = request.headers.get("X-Auth-Token", "")
    user_id = request.headers.get("X-User-Id", "")

    # Also support Bearer token format: "Bearer <authToken>:<userId>"
    if not auth_token:
        bearer = request.headers.get("Authorization", "")
        if bearer.startswith("Bearer ") and ":" in bearer[7:]:
            parts = bearer[7:].split(":", 1)
            auth_token, user_id = parts[0], parts[1]
        elif bearer.startswith("Bearer "):
            auth_token = bearer[7:]

    if not auth_token or not user_id:
        await _track_auth_failure(client_ip)
        return None

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{RC_URL}/api/v1/me",
            headers=_rc_user_headers(auth_token, user_id),
        )
    if resp.status_code != 200 or not resp.json().get("success", False):
        await _track_auth_failure(client_ip)
        return None
    username = resp.json().get("username", "")
    # Reject staff/bot accounts (staff SSO usernames don't contain hyphens, machine usernames always do)
    if username in ("bracerbot", "bracer-register"):
        return None
    if username in STAFF_USERNAMES:
        return None
    # Path traversal guard — allow hostname chars plus dots for hostname.user format
    if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9.\-]{0,126}[a-zA-Z0-9])?$", username):
        return None
    # Return hostname portion only (strip _windowsuser or .windowsuser suffix)
    # Machine hostnames never contain underscores or dots
    if "_" in username:
        return username.split("_")[0]
    if "." in username:
        return username.split(".")[0]
    return username


def _filter_log_lines(content: bytes) -> bytes:
    """Strip log lines older than 7 days. Keeps lines without a recognised timestamp."""
    cutoff = datetime.utcnow() - timedelta(days=7)
    lines   = content.decode("utf-8", errors="replace").splitlines(keepends=True)
    result  = []
    include = True
    for line in lines:
        m = re.match(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", line)
        if m:
            try:
                ts      = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
                include = ts >= cutoff
            except ValueError:
                include = True
        if include:
            result.append(line)
    return "".join(result).encode("utf-8")


@app.post("/api/machine/displayname")
async def update_display_name(request: Request):
    """Update the machine user's RC display name and username.
    Called by Electron client on startup and user change.
    Requires valid RC auth. Body: {"logged_in_user": "chris.paetz"}"""
    hostname = await _validate_machine_token(request, request.client.host)
    if not hostname:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    try:
        body = await request.json()
        logged_in_user = str(body.get("logged_in_user", "")).strip()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    display_name = _build_display_name(hostname, logged_in_user)
    new_username = _build_username(hostname, logged_in_user)
    async with httpx.AsyncClient(timeout=10.0) as client:
        existing = await _rc_find_machine_user(client, hostname)
        if not existing:
            raise HTTPException(status_code=404, detail="Machine not registered")
        await _rc_update_user(client, existing["_id"], name=display_name, username=new_username)
    logger.info(f"Display name/username updated: {hostname} -> {new_username} ({display_name})")
    return {"ok": True, "display_name": display_name, "username": new_username}


@app.get("/api/update/check")
async def update_check(request: Request):
    """Return the current app version and update type. Requires valid RC auth."""
    hostname = await _validate_machine_token(request, request.client.host)
    if not hostname:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    logger.info(f"Update check (authenticated): hostname={hostname}")

    try:
        with open("/var/www/install/latest.txt") as f:
            version = f.read().strip()
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="Version info unavailable")
    try:
        with open("/var/www/install/latest-type.txt") as f:
            update_type = f.read().strip()
    except FileNotFoundError:
        update_type = "installer"  # safe fallback
    return {"version": version, "update_type": update_type}


class ReauthRequest(BaseModel):
    hostname: str
    serial: str
    logged_in_user: str = ""  # Windows username for display name update

    @validator("hostname")
    def validate_hostname(cls, v):
        if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,62}[a-zA-Z0-9])?$", v):
            raise ValueError("Invalid hostname")
        return v.lower()

    @validator("serial")
    def validate_serial(cls, v):
        v = v.strip()
        if not (1 <= len(v) <= 128):
            raise ValueError("Serial must be 1-128 characters")
        # Only allow alphanumeric, dash, dot, underscore, space
        if not re.match(r"^[a-zA-Z0-9\-._\s]+$", v):
            raise ValueError("Invalid serial characters")
        return v

    @validator("logged_in_user")
    def validate_logged_in_user(cls, v):
        v = v.strip()
        if v and len(v) > 128:
            raise ValueError("logged_in_user must be <= 128 characters")
        return v


@app.post("/api/machine/reauth")
async def machine_reauth(body: ReauthRequest, request: Request):
    """Re-authenticate a machine that lost its DPAPI credentials (user change).
    Verifies the RC user exists, resets the password, and returns fresh credentials.
    Rate limited: uses public rate limit (5/min + cooldown)."""
    hostname = body.hostname
    serial = body.serial
    display_name = _build_display_name(hostname, body.logged_in_user)
    new_username = _build_username(hostname, body.logged_in_user)

    logger.info(f"Reauth request: hostname={hostname} serial=...{serial[-6:]} display={display_name} username={new_username} ip={request.client.host}")

    # Verify this is a machine account (not staff/bot)
    if hostname.lower() in ("bracerbot", "bracer-register"):
        raise HTTPException(status_code=403, detail="Not a machine account")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Verify the RC user exists (handles both old and new username formats)
        existing = await _rc_find_machine_user(client, hostname)
        if not existing:
            logger.warning(f"Reauth failed: user {hostname} not found")
            raise HTTPException(status_code=404, detail="Machine not registered")

        rc_user_id = existing["_id"]

        # Reset password, update display name + username, and log in
        new_password = generate_password()
        await _rc_update_user(client, rc_user_id, password=new_password, name=display_name, username=new_username)
        login_data = await _rc_login(client, new_username, new_password)
        auth_token = login_data["authToken"]

        # Look up rooms via admin API (reliable, no subscription propagation delay)
        machine_room_data = await _rc_get_room(client, hostname, room_type="p")
        machine_room = machine_room_data["_id"] if machine_room_data else None

        broadcast_data = await _rc_get_room(client, BROADCAST_CHANNEL, room_type="c")
        broadcast_room = broadcast_data["_id"] if broadcast_data else None

        # Find company room: list user's channels, find company-*-broadcast
        company_room = None
        resp = await client.get(
            f"{RC_URL}/api/v1/channels.list.joined",
            headers=_rc_user_headers(auth_token, login_data["userId"]),
            params={"count": 100},
        )
        if resp.status_code == 200 and resp.json().get("success"):
            for ch in resp.json().get("channels", []):
                rname = ch.get("name", "")
                if rname.startswith("company-") and rname.endswith("-broadcast"):
                    company_room = ch["_id"]
                    break

        # Fallback: if channels.list.joined didn't work, search via admin API
        if not company_room:
            resp = await client.get(
                f"{RC_URL}/api/v1/users.info",
                headers=_rc_admin_headers(),
                params={"userId": rc_user_id},
            )
            if resp.status_code == 200 and resp.json().get("success"):
                # Check rooms the user belongs to via admin rooms endpoint
                rooms_resp = await client.get(
                    f"{RC_URL}/api/v1/rooms.adminRooms",
                    headers=_rc_admin_headers(),
                    params={"filter": "company-", "types[]": "c", "count": 200},
                )
                if rooms_resp.status_code == 200 and rooms_resp.json().get("success"):
                    for room in rooms_resp.json().get("rooms", []):
                        rname = room.get("name", "")
                        if rname.startswith("company-") and rname.endswith("-broadcast"):
                            # Check if user is a member
                            mem_resp = await client.get(
                                f"{RC_URL}/api/v1/channels.members",
                                headers=_rc_admin_headers(),
                                params={"roomId": room["_id"], "count": 500},
                            )
                            if mem_resp.status_code == 200:
                                members = [m.get("username") for m in mem_resp.json().get("members", [])]
                                if any(m == hostname or m.startswith(f"{hostname}_") or m.startswith(f"{hostname}.") for m in members):
                                    company_room = room["_id"]
                                    break

    if not machine_room:
        logger.warning(f"Reauth: could not find machine room for {hostname}")

    logger.info(f"Reauth complete: {hostname} -> {new_username} ip={request.client.host}")
    return {
        "user_id": rc_user_id,
        "username": new_username,
        "auth_token": auth_token,
        "elevated": False,
        "room_id_machine": machine_room or "",
        "room_id_broadcast": broadcast_room or "",
        "room_id_company": company_room or "",
    }


@app.get("/api/update/asar")
async def update_asar(request: Request):
    """Stream the latest app.asar (legacy endpoint — updates now pushed via SuperOps).
    Requires valid RC auth."""
    hostname = await _validate_machine_token(request, request.client.host)
    if not hostname:
        raise HTTPException(status_code=401, detail="Invalid token")

    asar_path = "/var/www/install/app-latest.asar"
    if not os.path.exists(asar_path):
        raise HTTPException(status_code=503, detail="ASAR not available")

    def iterfile():
        with open(asar_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    logger.info(f"ASAR update download: hostname={hostname}")
    return StreamingResponse(
        iterfile(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="app.asar"'},
    )


@app.get("/api/update/download")
async def update_download(request: Request):
    """Stream the latest installer EXE (legacy endpoint — updates now pushed via SuperOps).
    Requires valid RC auth."""
    hostname = await _validate_machine_token(request, request.client.host)
    if not hostname:
        raise HTTPException(status_code=401, detail="Invalid token")

    exe_path = os.path.realpath(INSTALL_EXE_PATH)
    if not os.path.exists(exe_path):
        raise HTTPException(status_code=503, detail="Installer not available")

    exe_name = os.path.basename(exe_path)

    def iterfile():
        with open(exe_path, "rb") as f:
            while chunk := f.read(65536):
                yield chunk

    logger.info(f"Update download: hostname={hostname}")
    return StreamingResponse(
        iterfile(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{exe_name}"'},
    )


# ── Guest Chat (Public Website Widget) ─────────────────────────────────────────

GUEST_DB = "/opt/bracer-register/guest_sessions.db"
GUEST_ROOM_RETENTION_MS = 72 * 60 * 60 * 1000  # 72 hours


def _init_guest_db():
    db = sqlite3.connect(GUEST_DB)
    db.execute("""
        CREATE TABLE IF NOT EXISTS guest_sessions (
            user_id    TEXT PRIMARY KEY,
            room_id    TEXT NOT NULL,
            created_at REAL NOT NULL,
            last_activity REAL NOT NULL
        )
    """)
    db.commit()
    db.close()


_init_guest_db()


class GuestStartRequest(BaseModel):
    name: str = "Visitor"

    @validator("name")
    def validate_name(cls, v):
        v = v.strip()
        if not (1 <= len(v) <= 64):
            raise ValueError("Name must be 1-64 characters")
        # Strip anything that could be used for injection
        v = re.sub(r"[^\w\s\-.]", "", v)
        return v or "Visitor"


@app.post("/api/guest/start")
async def guest_start(request: Request, body: GuestStartRequest):
    """Create a temporary guest RC account and support room for the website chat widget."""
    guest_id_suffix = secrets.token_hex(8)
    guest_username = f"guest-{guest_id_suffix}"
    display_name = body.name

    logger.info(f"Guest chat start: name={display_name} ip={request.client.host}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Create guest RC user
        password = generate_password()
        guest_user = await _rc_create_user(client, guest_username, password, name=display_name)
        guest_user_id = guest_user["_id"]

        # 2. Log in as guest to get auth token
        login = await _rc_login(client, guest_username, password)
        auth_token = login["authToken"]

        # 3. Create a private group for guest support
        group_name = f"guest-chat-{guest_id_suffix}"
        group = await _rc_create_group(
            client,
            name=group_name,
            members=STAFF_USERNAMES + [BOT_USERNAME],
        )
        room_id = group["_id"]

        # Set topic
        await client.post(
            f"{RC_URL}/api/v1/groups.setTopic",
            headers=_rc_admin_headers(),
            json={"roomId": room_id, "topic": f"Website Chat \u2014 {display_name}"},
        )

        # 4. Invite guest to the room
        await _rc_invite_to_room(client, room_id, guest_user_id, room_type="p")

    # 5. Track the session for cleanup
    now = time.time()
    db = sqlite3.connect(GUEST_DB)
    db.execute(
        "INSERT OR REPLACE INTO guest_sessions VALUES (?, ?, ?, ?)",
        (guest_username, room_id, now, now),
    )
    db.commit()
    db.close()

    logger.info(f"Guest chat ready: {guest_username} room={room_id}")
    return {
        "user_id": guest_user_id,
        "username": guest_username,
        "auth_token": auth_token,
        "room_id": room_id,
        "server_url": f"https://{SERVER_NAME}",
    }


@app.post("/api/guest/heartbeat")
async def guest_heartbeat(request: Request):
    """Update last_activity timestamp for a guest session. Called periodically by widget."""
    auth_token = request.headers.get("X-Auth-Token", "")
    user_id = request.headers.get("X-User-Id", "")
    if not auth_token or not user_id:
        raise HTTPException(status_code=401, detail="Missing token")

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{RC_URL}/api/v1/me",
            headers=_rc_user_headers(auth_token, user_id),
        )
    if resp.status_code != 200 or not resp.json().get("success", False):
        raise HTTPException(status_code=401, detail="Invalid token")

    username = resp.json().get("username", "")
    if not username.startswith("guest-"):
        raise HTTPException(status_code=403, detail="Not a guest session")

    db = sqlite3.connect(GUEST_DB)
    db.execute(
        "UPDATE guest_sessions SET last_activity = ? WHERE user_id = ?",
        (time.time(), username),
    )
    db.commit()
    db.close()
    return {"ok": True}


@app.post("/api/logs/upload")
async def logs_upload(request: Request):
    """Receive a machine error log. Requires valid RC auth."""
    hostname = await _validate_machine_token(request, request.client.host)
    if not hostname:
        raise HTTPException(status_code=401, detail="Invalid token")

    body = await request.body()
    if len(body) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Log too large")

    # Validate content is valid UTF-8 text (reject binary/executable uploads)
    try:
        body.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="Log must be UTF-8 text")

    # Check for null bytes (binary data indicator)
    if b"\x00" in body:
        raise HTTPException(status_code=400, detail="Log must be plain text")

    filtered = _filter_log_lines(body)

    os.makedirs(LOG_STORE_DIR, exist_ok=True)
    log_path = os.path.join(LOG_STORE_DIR, f"{hostname}.log")
    with open(log_path, "wb") as f:
        f.write(filtered)

    logger.info(f"Log uploaded: hostname={hostname} size={len(filtered)}")
    return {"ok": True}


# ── Admin Dashboard ─────────────────────────────────────────────────────────────

HOLIDAY_CONFIG_PATH = "/opt/bracer-register/holiday.json"
AUTORESPONDER_CONFIG_PATH = "/opt/bracer-register/autoresponder.json"
ADMIN_SESSION_STORE: dict = {}  # session_id -> { user_id, access_token, expires }
ADMIN_SESSION_TTL = 8 * 3600  # 8 hours
ADMIN_SESSION_MAX = 100  # max concurrent sessions before forced cleanup
_admin_session_last_cleanup = 0.0


def _load_holiday_config() -> dict:
    try:
        with open(HOLIDAY_CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"enabled": False, "message": ""}


def _save_holiday_config(config: dict):
    with open(HOLIDAY_CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


def _load_autoresponder_config() -> dict:
    try:
        with open(AUTORESPONDER_CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"enabled": False, "delay_minutes": 20, "message": ""}


def _save_autoresponder_config(config: dict):
    with open(AUTORESPONDER_CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)


async def _validate_admin_session(request: Request, check_csrf: bool = False) -> str:
    """Validate admin session cookie. Returns user_id or raises 401.
    If check_csrf=True, also validates the X-CSRF-Token header (for POST endpoints)."""
    # Periodic cleanup of expired admin sessions
    global _admin_session_last_cleanup
    now = time.time()
    if len(ADMIN_SESSION_STORE) > ADMIN_SESSION_MAX or now - _admin_session_last_cleanup > 3600:
        expired = [sid for sid, s in ADMIN_SESSION_STORE.items() if now > s["expires"]]
        for sid in expired:
            del ADMIN_SESSION_STORE[sid]
        if expired:
            logger.info(f"Admin session cleanup: removed {len(expired)} expired sessions")
        _admin_session_last_cleanup = now

    session_id = request.cookies.get("bcw_admin")
    if not session_id or session_id not in ADMIN_SESSION_STORE:
        raise HTTPException(status_code=401, detail="Not authenticated")
    session = ADMIN_SESSION_STORE[session_id]
    if now > session["expires"]:
        del ADMIN_SESSION_STORE[session_id]
        raise HTTPException(status_code=401, detail="Session expired")

    # CSRF validation for state-changing (POST) requests
    if check_csrf:
        csrf_header = request.headers.get("X-CSRF-Token", "")
        csrf_expected = session.get("csrf_token", "")
        if not csrf_expected or not secrets.compare_digest(csrf_header, csrf_expected):
            logger.warning(f"CSRF validation failed for {session['user_id']}")
            raise HTTPException(status_code=403, detail="CSRF validation failed")

    return session["user_id"]


@app.get("/api/admin/login")
async def admin_login():
    """Redirect to Google OAuth consent screen for admin dashboard login."""
    state = secrets.token_hex(16)
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
        "state": state,
        "prompt": "select_account",
    })
    return RedirectResponse(url=f"https://accounts.google.com/o/oauth2/v2/auth?{params}")


@app.get("/api/admin/callback")
async def admin_callback(request: Request, code: str = "", error: str = ""):
    """Handle Google OAuth callback — exchange code for token, log into RC, create session."""

    if error:
        logger.warning(f"Google OAuth error: {error}")
        return RedirectResponse(url="/admin/?error=oauth_denied")

    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: Exchange auth code for Google access token
        token_resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            logger.warning(f"Google token exchange failed: {token_resp.status_code} {token_resp.text[:200]}")
            return RedirectResponse(url="/admin/?error=token_exchange")

        google_data = token_resp.json()
        google_access_token = google_data.get("access_token", "")
        if not google_access_token:
            logger.warning("Google token exchange returned no access_token")
            return RedirectResponse(url="/admin/?error=no_token")

        # Step 2: Get user's Google profile (email + name)
        userinfo_resp = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {google_access_token}"},
        )
        if userinfo_resp.status_code != 200:
            logger.warning(f"Google userinfo failed: {userinfo_resp.status_code}")
            return RedirectResponse(url="/admin/?error=userinfo")

        google_profile = userinfo_resp.json()
        google_email = google_profile.get("email", "").lower()
        google_name = google_profile.get("name", google_email)

        if not google_email:
            logger.warning("Google userinfo returned no email")
            return RedirectResponse(url="/admin/?error=no_email")

        # Step 3: Map Google email to RC username and check staff status
        # Staff emails: cpaetz@bracer.ca -> chris.paetz, teri@bracer.ca -> teri.sauve, etc.
        username = STAFF_EMAIL_MAP.get(google_email, "")

    if not username or username not in STAFF_USERNAMES:
        logger.warning(f"Admin login rejected: {google_email} is not a staff email")
        return RedirectResponse(url="/admin/?error=access_denied")

    # Create admin session (uses admin RC token for API calls, not per-user)
    session_id = secrets.token_hex(32)
    csrf_token = secrets.token_hex(32)
    ADMIN_SESSION_STORE[session_id] = {
        "user_id": username,
        "google_email": google_email,
        "google_name": google_name,
        "expires": time.time() + ADMIN_SESSION_TTL,
        "csrf_token": csrf_token,
    }

    logger.info(f"Admin login: {username}")
    response = RedirectResponse(url="/admin/", status_code=303)
    response.set_cookie(
        key="bcw_admin",
        value=session_id,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=ADMIN_SESSION_TTL,
    )
    response.set_cookie(
        key="bcw_csrf",
        value=csrf_token,
        httponly=False,
        secure=True,
        samesite="lax",
        max_age=ADMIN_SESSION_TTL,
    )
    return response


@app.post("/api/admin/logout")
async def admin_logout(request: Request):
    """Log out admin session."""
    session_id = request.cookies.get("bcw_admin")
    if session_id and session_id in ADMIN_SESSION_STORE:
        ADMIN_SESSION_STORE.pop(session_id)
    response = JSONResponse({"ok": True})
    response.delete_cookie("bcw_admin")
    response.delete_cookie("bcw_csrf")
    return response


@app.get("/admin/")
@app.get("/admin")
async def admin_dashboard():
    """Serve the admin dashboard HTML."""
    html_path = Path(__file__).parent / "admin" / "index.html"
    if not html_path.exists():
        raise HTTPException(status_code=404, detail="Admin dashboard not found")
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.get("/api/admin/status")
async def admin_status(request: Request):
    """Return dashboard status: online clients, holiday config, companies."""
    user_id = await _validate_admin_session(request)

    companies = {}

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Fetch all users (paginated)
        users = []
        offset = 0
        while True:
            resp = await client.get(
                f"{RC_URL}/api/v1/users.list",
                headers=_rc_admin_headers(),
                params={"count": 100, "offset": offset},
            )
            if resp.status_code != 200:
                break
            data = resp.json()
            users.extend(data.get("users", []))
            if offset + 100 >= data.get("total", 0):
                break
            offset += 100

        now = time.time()

        for user in users:
            username = user.get("username", "")

            # Skip staff, bot, guest, and service accounts
            if "." in username or username.startswith("guest-"):
                continue
            if username in ("bracerbot", "bracer-register", "admin"):
                continue
            if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,62}[a-zA-Z0-9])?$", username):
                continue

            # RC stores lastLogin and status
            last_login = user.get("lastLogin", "")
            status = user.get("status", "offline")
            is_online = status in ("online", "away")

            machine_info = {
                "hostname": username,
                "user_id": user.get("_id", ""),
                "online": is_online,
                "last_seen": last_login,
                "displayname": user.get("name", username),
            }

            # Look up rooms via admin rooms API
            company_name = None
            company_room = None
            machine_room = None

            resp2 = await client.get(
                f"{RC_URL}/api/v1/channels.list.joined",
                headers=_rc_admin_headers(),
                params={"count": 200},
            )
            # For machine rooms (groups), we need to look up by name
            machine_room_data = await _rc_get_room(client, username, room_type="p")
            if machine_room_data:
                machine_room = machine_room_data["_id"]

            # Find company room by checking user's subscriptions via admin
            resp3 = await client.get(
                f"{RC_URL}/api/v1/subscriptions.getAll",
                headers=_rc_admin_headers(),
            )
            # Alternative: look for company rooms that contain this user
            # For now, derive company from room naming convention
            resp4 = await client.get(
                f"{RC_URL}/api/v1/rooms.adminRooms",
                headers=_rc_admin_headers(),
                params={"filter": f"company-", "types[]": "c", "count": 200},
            )
            if resp4.status_code == 200 and resp4.json().get("success"):
                for room in resp4.json().get("rooms", []):
                    rname = room.get("name", "")
                    if rname.startswith("company-") and rname.endswith("-broadcast"):
                        # Check if this user is a member
                        resp5 = await client.get(
                            f"{RC_URL}/api/v1/channels.members",
                            headers=_rc_admin_headers(),
                            params={"roomId": room["_id"], "count": 500},
                        )
                        if resp5.status_code == 200:
                            members = resp5.json().get("members", [])
                            if any(m.get("username") == username for m in members):
                                company_room = room["_id"]
                                # Derive company name from room description or name
                                desc = room.get("description", "")
                                if desc:
                                    company_name = desc.split(" \u2014 ")[0].strip() if " \u2014 " in desc else desc
                                else:
                                    # Parse from room name: company-slug-broadcast -> slug
                                    slug = rname.replace("company-", "").replace("-broadcast", "")
                                    company_name = slug.replace("-", " ").title()
                                break

            machine_info["company"] = company_name or "Unknown"
            machine_info["machine_room"] = machine_room
            machine_info["company_room"] = company_room
            machine_info["created_at"] = user.get("createdAt", "")

            co_key = company_name or "Unknown"
            if co_key not in companies:
                companies[co_key] = {
                    "name": co_key,
                    "room_id": company_room,
                    "machines": [],
                    "online_count": 0,
                }
            companies[co_key]["machines"].append(machine_info)
            if is_online:
                companies[co_key]["online_count"] += 1

    holiday = _load_holiday_config()
    autoresponder = _load_autoresponder_config()

    # Get broadcast channel ID
    broadcast = await _rc_get_room(httpx.AsyncClient(timeout=10.0), BROADCAST_CHANNEL, room_type="c")
    broadcast_id = broadcast["_id"] if broadcast else ""

    total_machines = sum(len(c["machines"]) for c in companies.values())
    total_online = sum(c["online_count"] for c in companies.values())

    return {
        "user_id": user_id,
        "holiday": holiday,
        "autoresponder": autoresponder,
        "total_machines": total_machines,
        "total_online": total_online,
        "companies": dict(sorted(companies.items(), key=lambda x: x[0].lower())),
        "broadcast_room_id": broadcast_id,
    }


@app.post("/api/admin/holiday")
async def admin_holiday(request: Request):
    """Toggle holiday mode and/or set message."""
    user_id = await _validate_admin_session(request, check_csrf=True)
    body = await request.json()

    config = _load_holiday_config()
    if "enabled" in body:
        config["enabled"] = bool(body["enabled"])
    if "message" in body:
        config["message"] = str(body["message"])[:500]

    _save_holiday_config(config)
    logger.info(f"Holiday config updated by {user_id}: enabled={config['enabled']}")
    return {"ok": True, "holiday": config}


@app.post("/api/admin/autoresponder")
async def admin_autoresponder(request: Request):
    """Update autoresponder settings (enabled, delay_minutes, message)."""
    user_id = await _validate_admin_session(request, check_csrf=True)
    body = await request.json()

    config = _load_autoresponder_config()
    if "enabled" in body:
        config["enabled"] = bool(body["enabled"])
    if "delay_minutes" in body:
        config["delay_minutes"] = max(1, min(1440, int(body["delay_minutes"])))
    if "message" in body:
        config["message"] = str(body["message"])[:2000]

    _save_autoresponder_config(config)
    logger.info(f"Autoresponder config updated by {user_id}: enabled={config['enabled']} delay={config['delay_minutes']}m")
    return {"ok": True, "autoresponder": config}


@app.post("/api/admin/broadcast")
async def admin_broadcast(request: Request):
    """Send a broadcast message to a company room or all clients."""
    user_id = await _validate_admin_session(request, check_csrf=True)

    body = await request.json()
    message = str(body.get("message", "")).strip()
    target = body.get("target", "all")  # "all" or a room_id

    if not message:
        raise HTTPException(status_code=400, detail="Message required")
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="Message too long (max 2000 chars)")

    rooms_sent = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        if target == "all":
            # Send to bracer-broadcast channel (uses admin token)
            broadcast = await _rc_get_room(client, BROADCAST_CHANNEL, room_type="c")
            if not broadcast:
                raise HTTPException(status_code=500, detail="Broadcast channel not found")
            if await _rc_post_message(client, broadcast["_id"], message):
                rooms_sent.append(broadcast["_id"])
            else:
                raise HTTPException(status_code=500, detail="Failed to send broadcast")
        else:
            # Validate target is a company broadcast room
            resp = await client.get(
                f"{RC_URL}/api/v1/channels.info",
                headers=_rc_admin_headers(),
                params={"roomId": target},
            )
            if resp.status_code != 200 or not resp.json().get("success"):
                raise HTTPException(status_code=400, detail="Invalid target room")
            room_name = resp.json().get("channel", {}).get("name", "")
            if not room_name.startswith("company-") or not room_name.endswith("-broadcast"):
                raise HTTPException(status_code=403, detail="Target is not a company broadcast room")

            if await _rc_post_message(client, target, message):
                rooms_sent.append(target)
            else:
                raise HTTPException(status_code=500, detail="Failed to send message")

    logger.info(f"Broadcast by {user_id}: target={target} rooms={len(rooms_sent)}")
    return {"ok": True, "rooms_sent": len(rooms_sent)}


@app.get("/api/admin/messages")
async def admin_messages(
    request: Request,
    room_id: str = "",
    from_ts: int = 0,
    to_ts: int = 0,
):
    """Fetch messages from a machine support room within a time window for the conversation viewer."""
    await _validate_admin_session(request)

    if not room_id:
        raise HTTPException(status_code=400, detail="room_id is required")
    if from_ts <= 0 or to_ts <= 0:
        raise HTTPException(status_code=400, detail="from_ts and to_ts are required")
    if from_ts >= to_ts:
        raise HTTPException(status_code=400, detail="from_ts must be less than to_ts")
    if to_ts - from_ts > 86_400_000:
        raise HTTPException(status_code=400, detail="Time window cannot exceed 24 hours")

    MAX_MESSAGES = 500
    from_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(from_ts / 1000))
    to_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(to_ts / 1000))

    async with httpx.AsyncClient(timeout=30.0) as client:
        # RC groups.history for private rooms
        resp = await client.get(
            f"{RC_URL}/api/v1/groups.history",
            headers=_rc_admin_headers(),
            params={
                "roomId": room_id,
                "oldest": from_iso,
                "latest": to_iso,
                "count": MAX_MESSAGES,
            },
        )
        if resp.status_code != 200 or not resp.json().get("success"):
            # Try channels.history as fallback
            resp = await client.get(
                f"{RC_URL}/api/v1/channels.history",
                headers=_rc_admin_headers(),
                params={
                    "roomId": room_id,
                    "oldest": from_iso,
                    "latest": to_iso,
                    "count": MAX_MESSAGES,
                },
            )
            if resp.status_code != 200 or not resp.json().get("success"):
                raise HTTPException(status_code=502, detail="Failed to fetch messages")

        rc_messages = resp.json().get("messages", [])

    # Filter out bot messages, build response
    messages = []
    for msg in rc_messages:
        sender = msg.get("u", {})
        if sender.get("username") == BOT_USERNAME:
            continue
        ts = msg.get("ts", "")
        messages.append({
            "timestamp": ts,
            "sender_display": sender.get("name", sender.get("username", "")),
            "sender_id": sender.get("_id", ""),
            "body": msg.get("msg", ""),
            "event_id": msg.get("_id", ""),
        })

    # RC returns newest first — reverse for chronological order
    messages.reverse()
    truncated = len(rc_messages) >= MAX_MESSAGES

    logger.info(f"admin_messages: room={room_id} count={len(messages)} truncated={truncated}")
    return {"messages": messages, "truncated": truncated}


# ---------------------------------------------------------------------------
# Unreplied chat counter
# ---------------------------------------------------------------------------

_DISMISS_STATE_FILE = "/opt/bracer-register/unreplied_dismiss.json"


def _load_dismiss_state() -> dict:
    try:
        with open(_DISMISS_STATE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_dismiss_state(state: dict) -> None:
    try:
        with open(_DISMISS_STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception as e:
        logger.error(f"Failed to save dismiss state: {e}")


@app.get("/api/admin/unreplied")
async def admin_unreplied(request: Request):
    """Return count and list of machine rooms with unreplied client messages."""
    await _validate_admin_session(request)

    dismiss_state = _load_dismiss_state()
    unreplied_rooms = []

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Get all private groups (machine rooms are private groups named after hostnames)
        resp = await client.get(
            f"{RC_URL}/api/v1/rooms.adminRooms",
            headers=_rc_admin_headers(),
            params={"types[]": "p", "count": 500},
        )
        if resp.status_code != 200 or not resp.json().get("success"):
            return {"unreplied_count": 0, "unreplied_rooms": []}

        rooms = resp.json().get("rooms", [])

        for room in rooms:
            room_name = room.get("name", "")
            room_id = room.get("_id", "")

            # Skip non-machine rooms (guest rooms, etc.)
            if room_name.startswith("guest-"):
                continue
            if "." in room_name:
                continue
            if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,62}[a-zA-Z0-9])?$", room_name):
                continue

            # Get recent messages
            resp2 = await client.get(
                f"{RC_URL}/api/v1/groups.history",
                headers=_rc_admin_headers(),
                params={"roomId": room_id, "count": 20},
            )
            if resp2.status_code != 200 or not resp2.json().get("success"):
                continue

            messages = resp2.json().get("messages", [])

            # Find last non-bot message
            last_msg = None
            for msg in messages:
                sender_username = msg.get("u", {}).get("username", "")
                if sender_username == BOT_USERNAME:
                    continue
                last_msg = msg
                break

            if not last_msg:
                continue

            last_sender_username = last_msg.get("u", {}).get("username", "")
            if last_sender_username in STAFF_USERNAMES:
                # Staff already replied
                continue

            msg_id = last_msg.get("_id", "")
            # Check dismiss state
            dismissed = dismiss_state.get(room_id, {})
            if dismissed.get("event_id") == msg_id:
                continue

            # Derive company name from room members' company room membership
            company_name = "Unknown"
            # Simple heuristic: check if there's a company room for this machine
            # by looking at room metadata or user subscriptions
            # For now, leave as Unknown — will be enriched later

            unreplied_rooms.append({
                "room_id": room_id,
                "machine_hostname": room_name,
                "company": company_name,
                "last_message_from": last_msg.get("u", {}).get("name", last_sender_username),
                "last_message_sender_id": last_msg.get("u", {}).get("_id", ""),
                "last_message_body": last_msg.get("msg", ""),
                "last_message_time": last_msg.get("ts", ""),
                "last_message_event_id": msg_id,
            })

    unreplied_rooms.sort(key=lambda r: r.get("last_message_time", ""))
    logger.info(f"admin_unreplied: {len(unreplied_rooms)} unreplied rooms")
    return {"unreplied_count": len(unreplied_rooms), "unreplied_rooms": unreplied_rooms}


class DismissRequest(BaseModel):
    room_id: str
    event_id: str


@app.post("/api/admin/unreplied/dismiss")
async def admin_unreplied_dismiss(request: Request, body: DismissRequest):
    """Mark a room's current unreplied message as dismissed."""
    await _validate_admin_session(request)

    if not body.room_id:
        raise HTTPException(status_code=400, detail="room_id is required")
    if not body.event_id:
        raise HTTPException(status_code=400, detail="event_id is required")

    state = _load_dismiss_state()
    state[body.room_id] = {
        "event_id": body.event_id,
        "dismissed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _save_dismiss_state(state)
    logger.info(f"admin_unreplied_dismiss: room={body.room_id} event={body.event_id}")
    return {"ok": True}
