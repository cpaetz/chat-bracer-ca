from synapse.handlers.oidc import OidcMappingProvider
from typing import Any
import logging

logger = logging.getLogger(__name__)

STAFF_MAP = {
    "cpaetz": "chris.paetz",
    "tsauve": "teri.sauve",
}

ALLOWED_DOMAINS = {
    "bracer.ca",
    "bracersystems.net",
    "legacyheating.ca",
    "yegfboservices.com",
}


class BracerOidcMappingProvider(OidcMappingProvider):
    def __init__(self, config):
        pass

    @staticmethod
    def parse_config(config: dict):
        return {}

    def get_remote_user_id(self, userinfo: dict) -> str:
        return userinfo.get("email", "")

    async def map_user_attributes(
        self, userinfo: dict, token: Any, failures: int
    ) -> dict:
        email = userinfo.get("email", "")
        if isinstance(email, list):
            email = email[0] if email else ""

        # Domain restriction
        domain = email.split("@")[1].lower() if "@" in email else ""
        if domain not in ALLOWED_DOMAINS:
            logger.warning("BracerOidcMapper: rejected login from %s (domain %s not allowed)", email, domain)
            raise Exception(f"Access denied: {domain} is not an authorized domain")

        localpart = (email.split("@")[0] if "@" in email else email).lower()
        localpart = STAFF_MAP.get(localpart, localpart)
        if failures > 0:
            localpart = f"{localpart}_{failures}"
        display_name = userinfo.get("name", localpart)
        emails = [email] if email else []
        return {"localpart": localpart, "display_name": display_name, "emails": emails}
