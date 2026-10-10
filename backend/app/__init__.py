"""FinAlly backend application."""

import os

# Use litellm's bundled model map (pinned by uv.lock) instead of fetching a live copy at import;
# the live copy can change capability flags (e.g. reasoning_effort support) without notice.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
