"""Database access for the fixture API. Never imported, never executed."""

import os

# A read with no default: the process fails when the variable is absent.
DATABASE_URL = os.environ.get("DATABASE_URL")
