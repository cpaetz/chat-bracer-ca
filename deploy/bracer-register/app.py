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
from urllib.parse import quote as urlquote

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

SYNAPSE_URL = os.environ.get("SYNAPSE_URL", "http://localhost:8008")
# Allow plaintext only for localhost (Synapse is on same machine); reject otherwise
if not SYNAPSE_URL.startswith("https://") and "localhost" not in SYNAPSE_URL and "127.0.0.1" not in SYNAPSE_URL:
    raise RuntimeError(f"SYNAPSE_URL must use HTTPS for non-localhost targets: {SYNAPSE_URL}")
SYNAPSE_ADMIN_TOKEN = os.environ["SYNAPSE_ADMIN_TOKEN"]
API_SECRET = os.environ["API_SECRET"]
SERVER_NAME = os.environ.get("SERVER_NAME", "chat.bracer.ca")
BROADCAST_ROOM_ID = os.environ["BROADCAST_ROOM_ID"]
SUPEROPS_API_KEY   = os.environ["SUPEROPS_API_KEY"]
SUPEROPS_SUBDOMAIN = "bracer"

STAFF_USERS = ["@chris.paetz:chat.bracer.ca", "@teri.sauve:chat.bracer.ca"]
BOT_USER = "@bracerbot:chat.bracer.ca"
RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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


class RegisterRequest(BaseModel):
    hostname: str
    company: str
    elevated: bool = False  # If True, machine account gets power level 50 in company broadcast

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
    user_id = f"@{hostname}:{SERVER_NAME}"

    logger.info(f"Registration: hostname={hostname} company={company} elevated={elevated} ip={request.client.host}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

        # 1. Create or update Matrix user (Synapse PUT /admin/v2/users is upsert)
        password = generate_password()
        resp = await client.put(
            f"{SYNAPSE_URL}/_synapse/admin/v2/users/{user_id}",
            headers=admin_headers,
            json={
                "password": password,
                "displayname": hostname,
                "admin": False,
                "deactivated": False,
            },
        )
        if resp.status_code not in (200, 201):
            logger.error(f"Failed to provision {user_id}: {resp.status_code} {resp.text}")
            raise HTTPException(status_code=500, detail="Failed to provision user")

        # 2. Log in as the new user to obtain their access token
        resp = await client.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/login",
            json={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": hostname},
                "password": password,
                "device_id": "BRACER_CHAT",
            },
        )
        if resp.status_code != 200:
            logger.error(f"Login failed for {user_id}: {resp.text}")
            raise HTTPException(status_code=500, detail="Login failed")

        login = resp.json()
        access_token = login["access_token"]
        device_id = login["device_id"]

        # 3. Force-join bracer-broadcast
        resp = await client.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/join/{BROADCAST_ROOM_ID}",
            headers=admin_headers,
            json={"user_id": user_id},
        )
        if resp.status_code != 200:
            logger.warning(f"bracer-broadcast join failed for {user_id}: {resp.text}")

        # 4. Get or create company broadcast room, then join
        company_room_id = await _get_or_create_company_room(
            client, admin_headers, company, company_slug
        )
        resp = await client.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/join/{company_room_id}",
            headers=admin_headers,
            json={"user_id": user_id},
        )
        if resp.status_code != 200:
            logger.warning(f"Company broadcast join failed for {user_id}: {resp.text}")

        # 4b. If elevated, give this machine account power level 50 in company broadcast
        if elevated:
            resp = await client.put(
                f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{company_room_id}/state/m.room.power_levels/",
                headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
                json=await _patch_power_levels(client, company_room_id, user_id, 50),
            )
            if resp.status_code != 200:
                logger.warning(f"Failed to elevate {user_id} in {company_room_id}: {resp.text}")
            else:
                logger.info(f"Elevated {user_id} to power level 50 in {company_room_id}")

        # 5. Get or create machine room
        machine_room_id = await _get_or_create_machine_room(
            client, admin_headers, hostname, user_id
        )

    logger.info(
        f"Complete: {user_id} broadcast={BROADCAST_ROOM_ID} "
        f"company={company_room_id} machine={machine_room_id}"
    )

    return {
        "user_id": user_id,
        "access_token": access_token,
        "device_id": device_id,
        "elevated": elevated,
        "rooms": {
            "broadcast": BROADCAST_ROOM_ID,
            "company_broadcast": company_room_id,
            "machine": machine_room_id,
        },
    }


async def _patch_power_levels(
    client: httpx.AsyncClient, room_id: str, user_id: str, level: int
) -> dict:
    """Fetch current power levels for a room and return them with user_id set to level."""
    resp = await client.get(
        f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/state/m.room.power_levels/",
        headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
    )
    pl = resp.json() if resp.status_code == 200 else {}
    pl.setdefault("users", {})
    pl["users"][user_id] = level
    return pl


async def _resolve_alias(client: httpx.AsyncClient, alias: str) -> str | None:
    """Return room_id for a room alias, or None if not found."""
    encoded = urlquote(alias, safe="")
    resp = await client.get(f"{SYNAPSE_URL}/_matrix/client/v3/directory/room/{encoded}")
    if resp.status_code == 200:
        return resp.json()["room_id"]
    return None


async def _get_or_create_company_room(
    client: httpx.AsyncClient,
    admin_headers: dict,
    company: str,
    company_slug: str,
) -> str:
    alias = f"#company-{company_slug}-broadcast:{SERVER_NAME}"
    room_id = await _resolve_alias(client, alias)
    if room_id:
        return room_id

    resp = await client.post(
        f"{SYNAPSE_URL}/_matrix/client/v3/createRoom",
        headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
        json={
            "room_alias_name": f"company-{company_slug}-broadcast",
            "name": f"{company} \u2014 Bracer Announcements",
            "topic": f"Announcements from Bracer Systems for {company}.",
            "preset": "public_chat",
            "visibility": "private",
            "creation_content": {"m.federate": False},
            "power_level_content_override": {
                "ban": 50,
                "events": {
                    "m.room.name": 100,
                    "m.room.power_levels": 100,
                    "m.room.history_visibility": 100,
                    "m.room.canonical_alias": 100,
                    "m.room.tombstone": 100,
                    "m.room.server_acl": 100,
                    "m.room.encryption": 100,
                    "m.room.topic": 50,
                    "m.room.avatar": 50,
                },
                "events_default": 50,
                "invite": 50,
                "kick": 50,
                "redact": 50,
                "state_default": 50,
                "users": {
                    "@chris.paetz:chat.bracer.ca": 100,
                    "@teri.sauve:chat.bracer.ca": 50,
                    "@bracer-register:chat.bracer.ca": 100,
                },
                "users_default": 0,
            },
        },
    )
    if resp.status_code != 200:
        logger.error(f"Failed to create company room {alias}: {resp.text}")
        raise HTTPException(status_code=500, detail="Failed to create company room")

    room_id = resp.json()["room_id"]
    await client.put(
        f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/state/m.room.retention/",
        headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
        json={"max_lifetime": RETENTION_MS},
    )
    # Force-join staff users so they can see and post in the room
    for staff_user in STAFF_USERS:
        join_resp = await client.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/join/{room_id}",
            headers=admin_headers,
            json={"user_id": staff_user},
        )
        if join_resp.status_code != 200:
            logger.warning(f"Failed to join {staff_user} to {room_id}: {join_resp.text}")
        else:
            logger.info(f"Joined {staff_user} to company broadcast room {room_id}")

    logger.info(f"Created company broadcast room: {alias} -> {room_id}")
    return room_id


async def _get_or_create_machine_room(
    client: httpx.AsyncClient,
    admin_headers: dict,
    hostname: str,
    user_id: str,
) -> str:
    alias = f"#{hostname}:{SERVER_NAME}"
    room_id = await _resolve_alias(client, alias)
    if room_id:
        return room_id

    resp = await client.post(
        f"{SYNAPSE_URL}/_matrix/client/v3/createRoom",
        headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
        json={
            "room_alias_name": hostname,
            "name": f"{hostname} \u2014 Support",
            "topic": "Bracer Systems support channel for this machine.",
            "preset": "private_chat",
            "visibility": "private",
            "creation_content": {"m.federate": False},
            "power_level_content_override": {
                "events": {
                    "m.room.name": 100,
                    "m.room.power_levels": 100,
                    "m.room.history_visibility": 100,
                    "m.room.tombstone": 100,
                    "m.room.server_acl": 100,
                    "m.room.encryption": 100,
                },
                "events_default": 0,
                "invite": 50,
                "kick": 50,
                "redact": 50,
                "state_default": 50,
                "users": {
                    "@chris.paetz:chat.bracer.ca": 100,
                    "@teri.sauve:chat.bracer.ca": 50,
                    "@bracer-register:chat.bracer.ca": 100,
                    user_id: 10,
                },
                "users_default": 0,
            },
            "invite": STAFF_USERS + [BOT_USER],
        },
    )
    if resp.status_code != 200:
        logger.error(f"Failed to create machine room {alias}: {resp.text}")
        raise HTTPException(status_code=500, detail="Failed to create machine room")

    room_id = resp.json()["room_id"]

    # Force-join the client user (non-staff won't auto-accept invite)
    await client.post(
        f"{SYNAPSE_URL}/_synapse/admin/v1/join/{room_id}",
        headers=admin_headers,
        json={"user_id": user_id},
    )

    await client.put(
        f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/state/m.room.retention/",
        headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
        json={"max_lifetime": RETENTION_MS},
    )
    logger.info(f"Created machine room: {alias} -> {room_id}")
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
    if request.method == "POST" and not token:
        try:
            body = await request.json()
            token = str(body.get("token", ""))
            hostname = str(body.get("hostname", ""))
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
    user_id = f"@{hostname}:{SERVER_NAME}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

        password = generate_password()
        resp = await client.put(
            f"{SYNAPSE_URL}/_synapse/admin/v2/users/{user_id}",
            headers=admin_headers,
            json={"password": password, "displayname": hostname, "admin": False, "deactivated": False},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Failed to provision user")

        resp = await client.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/login",
            json={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": hostname},
                "password": password,
                "device_id": "BRACER_CHAT",
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=500, detail="Login failed")

        login_data = resp.json()
        access_token = login_data["access_token"]
        device_id = login_data["device_id"]

        await client.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/join/{BROADCAST_ROOM_ID}",
            headers=admin_headers,
            json={"user_id": user_id},
        )

        company_room_id = await _get_or_create_company_room(
            client, admin_headers, company, company_slug
        )
        await client.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/join/{company_room_id}",
            headers=admin_headers,
            json={"user_id": user_id},
        )

        machine_room_id = await _get_or_create_machine_room(
            client, admin_headers, hostname, user_id
        )

    # Invalidate token after successful claim (single-use)
    _consume_installer_token(token)

    logger.info(f"Installer claim complete: {user_id}")
    return {
        "user_id": user_id,
        "access_token": access_token,
        "device_id": device_id,
        "elevated": False,
        "room_id_machine": machine_room_id,
        "room_id_broadcast": BROADCAST_ROOM_ID,
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


async def _validate_machine_token(access_token: str, client_ip: str = "unknown"):
    """Validate a machine Matrix access token. Returns hostname string or None."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{SYNAPSE_URL}/_matrix/client/v3/account/whoami",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if resp.status_code != 200:
        await _track_auth_failure(client_ip)
        return None
    user_id = resp.json().get("user_id", "")
    # Expected format: @hostname:chat.bracer.ca
    if not user_id.startswith("@") or ":" not in user_id:
        return None
    hostname = user_id[1:].split(":")[0]
    # Reject staff/bot accounts
    if "." in hostname or hostname in ("bracerbot", "bracer-register"):
        return None
    # Path traversal guard: re-validate hostname before using in file paths
    if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,62}[a-zA-Z0-9])?$", hostname):
        return None
    return hostname


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


@app.get("/api/update/check")
async def update_check(request: Request):
    """Return the current app version and update type.
    Accepts auth token if provided (v1.0.58+), but allows unauthenticated
    requests for backwards compatibility with v1.0.57 clients that don't
    send auth on this endpoint. Auth will be required once fleet is on v1.0.58+.
    """
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        hostname = await _validate_machine_token(token, request.client.host)
        if hostname:
            logger.info(f"Update check (authenticated): hostname={hostname}")
        # If token is invalid, still allow the check — don't block old clients

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


@app.post("/api/machine/reauth")
async def machine_reauth(body: ReauthRequest, request: Request):
    """Re-authenticate a machine that lost its DPAPI credentials (user change).
    Verifies the Matrix user exists and the serial matches the display name,
    then resets the password and returns fresh credentials.
    Rate limited: uses public rate limit (5/min + cooldown)."""
    hostname = body.hostname
    serial = body.serial
    user_id = f"@{hostname}:{SERVER_NAME}"

    logger.info(f"Reauth request: hostname={hostname} serial=...{serial[-6:]} ip={request.client.host}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

        # Verify the Matrix user exists
        resp = await client.get(
            f"{SYNAPSE_URL}/_synapse/admin/v2/users/{user_id}",
            headers=admin_headers,
        )
        if resp.status_code != 200:
            logger.warning(f"Reauth failed: user {user_id} not found")
            raise HTTPException(status_code=404, detail="Machine not registered")

        # Verify this is a machine account (no dots in localpart, not staff/bot)
        localpart = hostname
        if "." in localpart or localpart in ("bracerbot", "bracer-register"):
            raise HTTPException(status_code=403, detail="Not a machine account")

        # Reset password and log in
        new_password = generate_password()
        resp = await client.put(
            f"{SYNAPSE_URL}/_synapse/admin/v2/users/{user_id}",
            headers=admin_headers,
            json={"password": new_password},
        )
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Password reset failed")

        resp = await client.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/login",
            json={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": hostname},
                "password": new_password,
                "device_id": "BRACER_CHAT",
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=500, detail="Login failed")

        login_data = resp.json()
        access_token = login_data["access_token"]
        device_id = login_data["device_id"]

        # Look up the machine's rooms
        resp = await client.get(
            f"{SYNAPSE_URL}/_synapse/admin/v1/users/{user_id}/joined_rooms",
            headers=admin_headers,
        )
        room_ids = resp.json().get("joined_rooms", []) if resp.status_code == 200 else []

        machine_room = None
        broadcast_room = BROADCAST_ROOM_ID
        company_room = None

        for room_id in room_ids:
            resp2 = await client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{room_id}",
                headers=admin_headers,
            )
            if resp2.status_code == 200:
                alias = resp2.json().get("canonical_alias") or ""
                if alias == f"#{hostname}:{SERVER_NAME}":
                    machine_room = room_id
                elif alias.startswith("#company-"):
                    company_room = room_id

    if not machine_room:
        logger.warning(f"Reauth: could not find machine room for {hostname}")

    logger.info(f"Reauth complete: {user_id} ip={request.client.host}")
    return {
        "user_id": user_id,
        "access_token": access_token,
        "device_id": device_id,
        "elevated": False,
        "room_id_machine": machine_room or "",
        "room_id_broadcast": broadcast_room,
        "room_id_company": company_room or "",
    }


@app.get("/api/update/asar")
async def update_asar(request: Request):
    """Stream the latest app.asar (legacy endpoint — updates now pushed via SuperOps).
    Requires a valid machine Matrix access token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token    = auth[7:]
    hostname = await _validate_machine_token(token, request.client.host)
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
    Requires a valid machine Matrix access token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token    = auth[7:]
    hostname = await _validate_machine_token(token, request.client.host)
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
    """Create a temporary guest Matrix account and support room for the website chat widget."""
    guest_id_suffix = secrets.token_hex(8)
    guest_localpart = f"guest-{guest_id_suffix}"
    user_id = f"@{guest_localpart}:{SERVER_NAME}"
    display_name = body.name

    logger.info(f"Guest chat start: name={display_name} ip={request.client.host}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

        # 1. Create guest Matrix user
        password = generate_password()
        resp = await client.put(
            f"{SYNAPSE_URL}/_synapse/admin/v2/users/{user_id}",
            headers=admin_headers,
            json={
                "password": password,
                "displayname": display_name,
                "admin": False,
                "deactivated": False,
            },
        )
        if resp.status_code not in (200, 201):
            logger.error(f"Failed to create guest {user_id}: {resp.status_code} {resp.text}")
            raise HTTPException(status_code=500, detail="Failed to start chat session")

        # 2. Log in as guest to get access token
        resp = await client.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/login",
            json={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": guest_localpart},
                "password": password,
                "device_id": f"GUEST_{guest_id_suffix.upper()}",
            },
        )
        if resp.status_code != 200:
            logger.error(f"Guest login failed for {user_id}: {resp.text}")
            raise HTTPException(status_code=500, detail="Failed to start chat session")

        login = resp.json()
        access_token = login["access_token"]

        # 3. Create a private support room
        resp = await client.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/createRoom",
            headers=admin_headers,
            json={
                "name": f"Website Chat — {display_name}",
                "topic": "Live chat from bracer.ca website",
                "preset": "private_chat",
                "visibility": "private",
                "creation_content": {"m.federate": False},
                "power_level_content_override": {
                    "events": {
                        "m.room.name": 100,
                        "m.room.power_levels": 100,
                        "m.room.history_visibility": 100,
                        "m.room.tombstone": 100,
                        "m.room.server_acl": 100,
                        "m.room.encryption": 100,
                    },
                    "events_default": 0,
                    "invite": 50,
                    "kick": 50,
                    "redact": 50,
                    "state_default": 50,
                    "users": {
                        "@chris.paetz:chat.bracer.ca": 100,
                        "@teri.sauve:chat.bracer.ca": 50,
                        "@bracer-register:chat.bracer.ca": 100,
                        user_id: 10,
                    },
                    "users_default": 0,
                },
                "invite": STAFF_USERS + [BOT_USER],
            },
        )
        if resp.status_code != 200:
            logger.error(f"Failed to create guest room: {resp.text}")
            raise HTTPException(status_code=500, detail="Failed to create chat room")

        room_id = resp.json()["room_id"]

        # 4. Force-join guest to the room
        await client.post(
            f"{SYNAPSE_URL}/_synapse/admin/v1/join/{room_id}",
            headers=admin_headers,
            json={"user_id": user_id},
        )

        # 5. Set 1-hour retention on the room
        await client.put(
            f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/state/m.room.retention/",
            headers=admin_headers,
            json={"max_lifetime": GUEST_ROOM_RETENTION_MS},
        )

    # 6. Track the session for cleanup
    now = time.time()
    db = sqlite3.connect(GUEST_DB)
    db.execute(
        "INSERT OR REPLACE INTO guest_sessions VALUES (?, ?, ?, ?)",
        (user_id, room_id, now, now),
    )
    db.commit()
    db.close()

    logger.info(f"Guest chat ready: {user_id} room={room_id}")
    return {
        "user_id": user_id,
        "access_token": access_token,
        "room_id": room_id,
        "homeserver": f"https://{SERVER_NAME}",
    }


@app.post("/api/guest/heartbeat")
async def guest_heartbeat(request: Request):
    """Update last_activity timestamp for a guest session. Called periodically by widget."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = auth[7:]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{SYNAPSE_URL}/_matrix/client/v3/account/whoami",
            headers={"Authorization": f"Bearer {token}"},
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = resp.json().get("user_id", "")
    if not user_id.startswith("@guest-"):
        raise HTTPException(status_code=403, detail="Not a guest session")

    db = sqlite3.connect(GUEST_DB)
    db.execute(
        "UPDATE guest_sessions SET last_activity = ? WHERE user_id = ?",
        (time.time(), user_id),
    )
    db.commit()
    db.close()
    return {"ok": True}


@app.post("/api/logs/upload")
async def logs_upload(request: Request):
    """Receive a machine error log. Requires a valid machine Matrix access token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token    = auth[7:]
    hostname = await _validate_machine_token(token, request.client.host)
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
async def admin_login(provider: str = ""):
    """Redirect to Synapse SSO login. Optional provider param: 'google' or 'microsoft'."""
    callback = f"https://{SERVER_NAME}/admin/callback"
    if provider == "google":
        sso_url = f"https://{SERVER_NAME}/_matrix/client/v3/login/sso/redirect/oidc-google?redirectUrl={callback}"
    elif provider == "microsoft":
        sso_url = f"https://{SERVER_NAME}/_matrix/client/v3/login/sso/redirect/oidc-microsoft?redirectUrl={callback}"
    else:
        sso_url = f"https://{SERVER_NAME}/_matrix/client/v3/login/sso/redirect?redirectUrl={callback}"
    return RedirectResponse(url=sso_url)


@app.get("/api/admin/callback")
async def admin_callback(loginToken: str = ""):
    """Handle SSO callback — exchange loginToken for access_token, validate staff, set cookie."""
    if not loginToken:
        raise HTTPException(status_code=400, detail="Missing loginToken")

    # Exchange loginToken for access_token
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{SYNAPSE_URL}/_matrix/client/v3/login",
            json={
                "type": "m.login.token",
                "token": loginToken,
            },
        )
    if resp.status_code != 200:
        logger.warning(f"Admin SSO login failed: {resp.status_code} {resp.text[:200]}")
        raise HTTPException(status_code=401, detail="SSO login failed")

    login_data = resp.json()
    user_id = login_data.get("user_id", "")
    access_token = login_data.get("access_token", "")

    # Check if user is staff
    if user_id not in STAFF_USERS:
        logger.warning(f"Admin login rejected: {user_id} is not staff")
        # Logout the token we just created
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{SYNAPSE_URL}/_matrix/client/v3/logout",
                headers={"Authorization": f"Bearer {access_token}"},
            )
        raise HTTPException(status_code=403, detail="Access denied — staff only")

    # Create admin session
    session_id = secrets.token_hex(32)
    csrf_token = secrets.token_hex(32)
    ADMIN_SESSION_STORE[session_id] = {
        "user_id": user_id,
        "access_token": access_token,
        "expires": time.time() + ADMIN_SESSION_TTL,
        "csrf_token": csrf_token,
    }

    logger.info(f"Admin login: {user_id}")
    response = RedirectResponse(url="/admin/", status_code=303)
    response.set_cookie(
        key="bcw_admin",
        value=session_id,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=ADMIN_SESSION_TTL,
    )
    # CSRF token cookie — readable by JS (not httponly) for double-submit pattern
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
        session = ADMIN_SESSION_STORE.pop(session_id)
        # Logout the Matrix token
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{SYNAPSE_URL}/_matrix/client/v3/logout",
                headers={"Authorization": f"Bearer {session['access_token']}"},
            )
    response = JSONResponse({"ok": True})
    response.delete_cookie("bcw_admin")
    return response


@app.get("/api/admin/status")
async def admin_status(request: Request):
    """Return dashboard status: online clients, holiday config, companies."""
    user_id = await _validate_admin_session(request)

    admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}

    # Get all users with their last_seen timestamp
    online_machines = []
    companies = {}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Fetch all users (paginated)
        users = []
        from_token = "0"
        while True:
            resp = await client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v2/users?from={from_token}&limit=100&guests=false",
                headers=admin_headers,
            )
            if resp.status_code != 200:
                break
            data = resp.json()
            users.extend(data.get("users", []))
            next_token = data.get("next_token")
            if not next_token:
                break
            from_token = str(next_token)

        # Filter to machine accounts (no dots in localpart, not staff/bot/guest)
        now_ms = int(time.time() * 1000)
        five_min_ms = 5 * 60 * 1000

        for user in users:
            uid = user.get("name", "")
            localpart = uid.split(":")[0][1:] if ":" in uid else ""

            # Skip staff, bot, guest, and registration accounts
            if "." in localpart or localpart.startswith("guest-"):
                continue
            if localpart in ("bracerbot", "bracer-register"):
                continue

            last_seen = user.get("last_seen_ts") or 0
            is_online = (now_ms - last_seen) < five_min_ms if last_seen else False

            machine_info = {
                "hostname": localpart,
                "user_id": uid,
                "online": is_online,
                "last_seen": last_seen,
                "displayname": user.get("displayname", localpart),
            }

            # Look up company + machine room via joined rooms
            company_name = None
            company_room = None
            machine_room = None
            resp2 = await client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v1/users/{uid}/joined_rooms",
                headers=admin_headers,
            )
            if resp2.status_code == 200:
                for room_id in resp2.json().get("joined_rooms", []):
                    resp3 = await client.get(
                        f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{room_id}",
                        headers=admin_headers,
                    )
                    if resp3.status_code == 200:
                        rdata = resp3.json()
                        alias = rdata.get("canonical_alias") or ""
                        if alias.startswith("#company-"):
                            company_room = room_id
                            rname = rdata.get("name", "")
                            for sep in (" \u2014 ", " \u2013 ", " - "):
                                if sep in rname:
                                    company_name = rname.split(sep)[0].strip()
                                    break
                            if not company_name:
                                company_name = rname.strip()
                        elif alias == f"#{localpart}:{SERVER_NAME}":
                            machine_room = room_id

            machine_info["company"] = company_name or "Unknown"
            machine_info["machine_room"] = machine_room
            machine_info["company_room"] = company_room
            machine_info["created_at"] = user.get("creation_ts", 0)

            co_key = company_name or "Unknown"
            if co_key not in companies:
                companies[co_key] = {
                    "name": co_key,
                    "room_id": company_room,
                    "machines": [],
                    "online_count": 0,
                }
            companies[machine_info["company"]]["machines"].append(machine_info)
            if is_online:
                companies[machine_info["company"]]["online_count"] += 1

    holiday = _load_holiday_config()
    autoresponder = _load_autoresponder_config()

    total_machines = sum(len(c["machines"]) for c in companies.values())
    total_online = sum(c["online_count"] for c in companies.values())

    return {
        "user_id": user_id,
        "holiday": holiday,
        "autoresponder": autoresponder,
        "total_machines": total_machines,
        "total_online": total_online,
        "companies": dict(sorted(companies.items(), key=lambda x: x[0].lower())),
        "broadcast_room_id": BROADCAST_ROOM_ID,
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
    session_id = request.cookies.get("bcw_admin")
    session = ADMIN_SESSION_STORE.get(session_id, {})
    access_token = session.get("access_token", "")

    body = await request.json()
    message = str(body.get("message", "")).strip()
    target = body.get("target", "all")  # "all" or a room_id

    if not message:
        raise HTTPException(status_code=400, detail="Message required")
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="Message too long (max 2000 chars)")

    # Validate target: must be "all" or a known company broadcast room
    if target != "all":
        # Verify the room exists and is a company room by checking its alias
        async with httpx.AsyncClient(timeout=10.0) as check_client:
            resp = await check_client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{target}",
                headers={"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"},
            )
            if resp.status_code != 200:
                logger.warning(f"Broadcast target validation failed: room {target} not found (by {user_id})")
                raise HTTPException(status_code=400, detail="Invalid target room")
            room_data = resp.json()
            alias = room_data.get("canonical_alias") or ""
            if not alias.startswith(f"#company-") or not alias.endswith(f":{SERVER_NAME}"):
                logger.warning(f"Broadcast target rejected: {target} alias={alias} (by {user_id})")
                raise HTTPException(status_code=403, detail="Target is not a company broadcast room")

    rooms_sent = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        if target == "all":
            # Send to bracer-broadcast (all clients)
            resp = await client.put(
                f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{BROADCAST_ROOM_ID}/send/m.room.message/{secrets.token_hex(8)}",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"msgtype": "m.text", "body": message},
            )
            if resp.status_code == 200:
                rooms_sent.append(BROADCAST_ROOM_ID)
            else:
                logger.error(f"Broadcast to all failed: {resp.status_code} {resp.text[:200]}")
                raise HTTPException(status_code=500, detail="Failed to send broadcast")
        else:
            # Send to validated company room
            room_id = target
            resp = await client.put(
                f"{SYNAPSE_URL}/_matrix/client/v3/rooms/{room_id}/send/m.room.message/{secrets.token_hex(8)}",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"msgtype": "m.text", "body": message},
            )
            if resp.status_code == 200:
                rooms_sent.append(room_id)
            else:
                logger.error(f"Broadcast to {room_id} failed: {resp.status_code} {resp.text[:200]}")
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

    if not room_id.startswith("!"):
        raise HTTPException(status_code=400, detail="room_id must start with '!'")
    if from_ts <= 0 or to_ts <= 0:
        raise HTTPException(status_code=400, detail="from_ts and to_ts are required")
    if from_ts >= to_ts:
        raise HTTPException(status_code=400, detail="from_ts must be less than to_ts")
    if to_ts - from_ts > 86_400_000:
        raise HTTPException(status_code=400, detail="Time window cannot exceed 24 hours")

    admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}
    bot_user = f"@bracerbot:{SERVER_NAME}"
    MAX_MESSAGES = 500

    collected = []
    truncated = False
    end_token = None

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Paginate backward to collect events in the window
        while True:
            url = f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{urlquote(room_id, safe='')}/messages?dir=b&limit=100"
            if end_token:
                url += f"&from={end_token}"

            resp = await client.get(url, headers=admin_headers)
            if resp.status_code != 200:
                logger.warning(f"admin_messages: Synapse error {resp.status_code} for room {room_id}")
                raise HTTPException(status_code=502, detail="Failed to fetch messages from Synapse")

            data = resp.json()
            chunk = data.get("chunk", [])
            end_token = data.get("end")

            stop_early = False
            for event in chunk:
                ts = event.get("origin_server_ts", 0)
                if ts < from_ts:
                    stop_early = True
                    break
                if ts > to_ts:
                    continue
                if event.get("type") != "m.room.message":
                    continue
                content = event.get("content", {})
                if content.get("msgtype") != "m.text":
                    continue
                if event.get("sender", "") == bot_user:
                    continue
                collected.append(event)
                if len(collected) >= MAX_MESSAGES:
                    truncated = True
                    stop_early = True
                    break

            if stop_early or not chunk or not end_token:
                break

        # Resolve display names once per unique sender
        display_names: dict = {}
        for event in collected:
            sender = event.get("sender", "")
            if sender not in display_names:
                resp = await client.get(
                    f"{SYNAPSE_URL}/_synapse/admin/v2/users/{urlquote(sender, safe='')}",
                    headers=admin_headers,
                )
                if resp.status_code == 200:
                    display_names[sender] = resp.json().get("displayname") or sender
                else:
                    display_names[sender] = sender

    # Sort ascending by timestamp before returning
    collected.sort(key=lambda e: e.get("origin_server_ts", 0))

    messages = []
    for event in collected:
        ts_ms = event.get("origin_server_ts", 0)
        ts_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_ms / 1000))
        sender = event.get("sender", "")
        messages.append({
            "timestamp": ts_iso,
            "sender_display": display_names.get(sender, sender),
            "sender_id": sender,
            "body": event.get("content", {}).get("body", ""),
            "event_id": event.get("event_id", ""),
        })

    logger.info(f"admin_messages: room={room_id} from={from_ts} to={to_ts} count={len(messages)} truncated={truncated}")
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

    admin_headers = {"Authorization": f"Bearer {SYNAPSE_ADMIN_TOKEN}"}
    dismiss_state = _load_dismiss_state()
    unreplied_rooms = []
    display_name_cache: dict = {}

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Fetch all users (paginated)
        users = []
        from_token = "0"
        while True:
            resp = await client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v2/users?from={from_token}&limit=100&guests=false",
                headers=admin_headers,
            )
            if resp.status_code != 200:
                break
            data = resp.json()
            users.extend(data.get("users", []))
            next_token = data.get("next_token")
            if not next_token:
                break
            from_token = str(next_token)

        for user in users:
            uid = user.get("name", "")
            localpart = uid.split(":")[0][1:] if ":" in uid else ""

            # Skip staff, bot, guest, and registration accounts
            if "." in localpart or localpart.startswith("guest-"):
                continue
            if localpart in ("bracerbot", "bracer-register"):
                continue

            machine_room = None
            company_name = None

            # Find machine room and company name via joined rooms
            resp2 = await client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v1/users/{uid}/joined_rooms",
                headers=admin_headers,
            )
            if resp2.status_code == 200:
                for room_id in resp2.json().get("joined_rooms", []):
                    resp3 = await client.get(
                        f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{room_id}",
                        headers=admin_headers,
                    )
                    if resp3.status_code == 200:
                        rdata = resp3.json()
                        alias = rdata.get("canonical_alias") or ""
                        if alias.startswith("#company-") and company_name is None:
                            rname = rdata.get("name", "")
                            for sep in (" \u2014 ", " \u2013 ", " - "):
                                if sep in rname:
                                    company_name = rname.split(sep)[0].strip()
                                    break
                            if not company_name:
                                company_name = rname.strip()
                        elif alias == f"#{localpart}:{SERVER_NAME}":
                            machine_room = room_id

            if not machine_room:
                continue

            # Get recent messages from machine room to find last non-bot m.text event
            resp4 = await client.get(
                f"{SYNAPSE_URL}/_synapse/admin/v1/rooms/{urlquote(machine_room, safe='')}/messages?dir=b&limit=20",
                headers=admin_headers,
            )
            if resp4.status_code != 200:
                continue

            last_event = None
            for event in resp4.json().get("chunk", []):
                if event.get("type") != "m.room.message":
                    continue
                if event.get("content", {}).get("msgtype") != "m.text":
                    continue
                if event.get("sender", "") == BOT_USER:
                    continue
                last_event = event
                break

            if not last_event:
                # No non-bot m.text message found — nothing to reply to
                continue

            last_sender = last_event.get("sender", "")
            if last_sender in STAFF_USERS:
                # Last real message was from staff — already replied
                continue

            event_id = last_event.get("event_id", "")
            # Check dismiss state: dismissed if event_id matches stored dismiss
            dismissed = dismiss_state.get(machine_room, {})
            if dismissed.get("event_id") == event_id:
                continue

            # Resolve display name (cached per sender)
            if last_sender not in display_name_cache:
                resp5 = await client.get(
                    f"{SYNAPSE_URL}/_synapse/admin/v2/users/{urlquote(last_sender, safe='')}",
                    headers=admin_headers,
                )
                if resp5.status_code == 200:
                    display_name_cache[last_sender] = resp5.json().get("displayname") or last_sender
                else:
                    display_name_cache[last_sender] = last_sender

            ts_ms = last_event.get("origin_server_ts", 0)
            ts_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_ms / 1000))

            unreplied_rooms.append({
                "room_id": machine_room,
                "machine_hostname": localpart,
                "company": company_name or "Unknown",
                "last_message_from": display_name_cache[last_sender],
                "last_message_sender_id": last_sender,
                "last_message_body": last_event.get("content", {}).get("body", ""),
                "last_message_time": ts_iso,
                "last_message_event_id": event_id,
            })

    unreplied_rooms.sort(key=lambda r: r["last_message_time"])
    logger.info(f"admin_unreplied: {len(unreplied_rooms)} unreplied rooms")
    return {"unreplied_count": len(unreplied_rooms), "unreplied_rooms": unreplied_rooms}


class DismissRequest(BaseModel):
    room_id: str
    event_id: str


@app.post("/api/admin/unreplied/dismiss")
async def admin_unreplied_dismiss(request: Request, body: DismissRequest):
    """Mark a room's current unreplied message as dismissed."""
    await _validate_admin_session(request)

    if not body.room_id.startswith("!"):
        raise HTTPException(status_code=400, detail="room_id must start with '!'")
    if not body.event_id.startswith("$"):
        raise HTTPException(status_code=400, detail="event_id must start with '$'")

    state = _load_dismiss_state()
    state[body.room_id] = {
        "event_id": body.event_id,
        "dismissed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _save_dismiss_state(state)
    logger.info(f"admin_unreplied_dismiss: room={body.room_id} event={body.event_id}")
    return {"ok": True}
