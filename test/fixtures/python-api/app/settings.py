"""Settings for the fixture API. Never imported, never executed."""

import os
from os import environ

from pydantic_settings import BaseSettings

# The first read in this file is a name nothing declares, so the missing-in-env
# finding does not depend on which read the scanner reports first.
REGION = environ.get("X", "y")
# Three accessor shapes on the os module, plus one through an import binding.
# DEBUG_HOST is required and lives in a developer-only file, which is a prod-crash.
DEBUG_HOST = os.environ["DEBUG_HOST"]
APP_NAME = os.environ.get("APP_NAME")
WORKERS = os.getenv("WORKERS", "4")


class Settings(BaseSettings):
    """Field names match the environment variable names exactly."""

    DATABASE_URL: str
    LOG_LEVEL: str = "info"
