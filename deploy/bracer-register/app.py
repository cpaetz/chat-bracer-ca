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
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, validator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

SYNAPSE_URL = os.environ.get("SYNAPSE_URL", "http://localhost:8008")
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
_rate_store: dict = defaultdict(list)
_rate_lock = asyncio.Lock()

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


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path in ("/api/register", "/api/companies", "/api/installer/claim"):
        ip = request.client.host
        now = time.monotonic()
        async with _rate_lock:
            _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_LIMIT_WINDOW]
            if len(_rate_store[ip]) >= RATE_LIMIT_MAX:
                logger.warning(f"Rate limit exceeded for {ip}")
                return JSONResponse(status_code=429, content={"detail": "Too many requests"})
            _rate_store[ip].append(now)
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


@app.get("/api/installer/claim")
async def installer_claim(request: Request, token: str, hostname: str):
    """Validate token and register a machine. Called by the NSIS EXE on client machines."""
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


@app.get("/api/installer/app")
async def installer_app(token: str):
    """Stream the BracerChat installer EXE. Called by the NSIS EXE on client machines."""
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

    company_safe = re.sub(r"[^a-zA-Z0-9]", "-", company).strip("-")[:40]
    token_short  = token[:12]
    exe_name     = f"BracerChatInstall-{company_safe}.exe"

    with open(NSIS_TEMPLATE_PATH) as f:
        nsi = f.read()
    with open(PS_TEMPLATE_PATH) as f:
        ps = f.read()

    ps  = ps.replace("{{TOKEN}}", token)
    nsi = nsi.replace("{{EXE_NAME}}", exe_name)
    nsi = nsi.replace("{{COMPANY}}", company)
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


async def _validate_machine_token(access_token: str):
    """Validate a machine Matrix access token. Returns hostname string or None."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{SYNAPSE_URL}/_matrix/client/v3/account/whoami",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if resp.status_code != 200:
        return None
    user_id = resp.json().get("user_id", "")
    # Expected format: @hostname:chat.bracer.ca
    if not user_id.startswith("@") or ":" not in user_id:
        return None
    hostname = user_id[1:].split(":")[0]
    # Reject staff/bot accounts
    if "." in hostname or hostname in ("bracerbot", "bracer-register"):
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
async def update_check():
    """Return the current app version and update type. Public — no auth required.
    update_type: 'asar' for code-only updates (~3 MB), 'installer' for Electron/native dep bumps (~92 MB).
    """
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


@app.get("/api/update/asar")
async def update_asar(request: Request):
    """Stream the latest app.asar (~3 MB). Requires a valid machine Matrix access token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token    = auth[7:]
    hostname = await _validate_machine_token(token)
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
    """Stream the latest installer EXE. Requires a valid machine Matrix access token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token    = auth[7:]
    hostname = await _validate_machine_token(token)
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


@app.post("/api/logs/upload")
async def logs_upload(request: Request):
    """Receive a machine error log. Requires a valid machine Matrix access token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token    = auth[7:]
    hostname = await _validate_machine_token(token)
    if not hostname:
        raise HTTPException(status_code=401, detail="Invalid token")

    body = await request.body()
    if len(body) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Log too large")

    filtered = _filter_log_lines(body)

    os.makedirs(LOG_STORE_DIR, exist_ok=True)
    log_path = os.path.join(LOG_STORE_DIR, f"{hostname}.log")
    with open(log_path, "wb") as f:
        f.write(filtered)

    logger.info(f"Log uploaded: hostname={hostname} size={len(filtered)}")
    return {"ok": True}
