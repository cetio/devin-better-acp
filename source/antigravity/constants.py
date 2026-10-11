from pathlib import Path


VERSION = "0.5.0"
DEFAULT_SERVER = Path.home() / ".local/opt/agy-acp/current/agy_acp_server.par"
DEFAULT_DEBUG_LOG = Path.home() / ".local/state/devin-better-acp/antigravity-acp.jsonl"
DEFAULT_ICON_URL = "https://cdn.jsdelivr.net/gh/cetio/devin-better-acp@main/images/antigravity-acp.svg"
KILL_GRACE_SECONDS = 2
MAX_READ_PROGRESS = 128
MAX_INTEGRATION_FRAME_BYTES = 1024 * 1024
INTEGRATION_TIMEOUT_SECONDS = 600
SHIM_COMMAND = "devin-shim"
AGENT_TITLE = "Antigravity (DBA)"
