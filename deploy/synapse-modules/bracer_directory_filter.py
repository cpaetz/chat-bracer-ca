import logging

logger = logging.getLogger(__name__)

DEFAULT_STAFF_USERS = [
    "@chris.paetz:chat.bracer.ca",
    "@teri.sauve:chat.bracer.ca",
]


class BracerDirectoryFilter:
    """Synapse module: hide machine/bot accounts from non-staff user directory searches.

    Staff users (configurable via staff_users in homeserver.yaml) see all accounts.
    Non-staff users only see accounts whose localpart contains a dot (i.e. real
    human accounts like first.last). Accounts with no dot in the localpart —
    machine accounts (desktop-*, laptop-*), bots (@bracerbot), and service
    accounts (@bracer-register) — are hidden.
    """

    def __init__(self, config, api):
        self._api = api
        self._staff_users = set(config.get("staff_users", DEFAULT_STAFF_USERS))

        api.register_spam_checker_callbacks(
            check_username_for_spam=self.check_username_for_spam
        )

        logger.info(
            "BracerDirectoryFilter loaded, staff_users=%s", self._staff_users
        )

    @staticmethod
    def parse_config(config):
        return config

    async def check_username_for_spam(
        self, user_profile: dict, requester_id: str
    ) -> bool:
        """Return True to hide user_profile from requester_id's directory results.

        Staff requesters see everyone. Non-staff requesters only see accounts
        whose localpart contains a dot (human accounts).
        """
        if requester_id in self._staff_users:
            return False

        user_id = user_profile.get("user_id", "")
        # Extract localpart: @localpart:server → localpart
        if ":" in user_id and user_id.startswith("@"):
            localpart = user_id[1:].split(":")[0]
        else:
            localpart = user_id.lstrip("@")

        if "." not in localpart:
            logger.debug(
                "BracerDirectoryFilter: hiding %s from non-staff %s (no dot in localpart)",
                user_id,
                requester_id,
            )
            return True

        return False
