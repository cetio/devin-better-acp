#!/usr/bin/env bash
set -euo pipefail

usage()
{
    printf 'Usage: %s [--dry-run]\n' "${0##*/}"
}

dry_run=0
case "${1:-}" in
    "") ;;
    --dry-run) dry_run=1 ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
if (( $# > 1 )); then
    usage >&2
    exit 2
fi

home_dir=${HOME:?HOME must be set}
python=${PYTHON:-python3}
root_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_shim="$root_dir/bin/antigravity-acp.py"
install_shim=${DEVIN_BETTER_ACP_SHIM_PATH:-"$home_dir/.local/bin/devin-antigravity-acp.py"}
server_path=${AGY_ACP_SERVER_PATH:-"$home_dir/.local/opt/agy-acp/current/agy_acp_server.par"}
registry_path=${DEVIN_ACP_REGISTRY_PATH:-"$home_dir/.windsurf/acp/registry.json"}

if ! command -v "$python" >/dev/null 2>&1; then
    printf 'Python executable not found: %s\n' "$python" >&2
    exit 1
fi
if [[ ! -f "$source_shim" ]]; then
    printf 'Shim source not found: %s\n' "$source_shim" >&2
    exit 1
fi
if [[ ! -f "$server_path" ]]; then
    printf 'Antigravity ACP server not found: %s\n' "$server_path" >&2
    exit 1
fi

entry_json=$("$python" "$source_shim" \
    --registry-entry \
    --server "$server_path" \
    --spoof-zed \
    --debug \
    --devin-config \
    -- \
    --uid=)
registry_json=$("$python" - "$registry_path" "$entry_json" "$install_shim" <<'PY'
import json
import sys
from pathlib import Path

registry_path = Path(sys.argv[1])
entry = json.loads(sys.argv[2])
install_shim = str(Path(sys.argv[3]))
platform_launches = entry.get("distribution", {}).get("binary")
if not isinstance(platform_launches, dict):
    raise SystemExit("Generated ACP registry entry has no binary launch configuration")
for launch in platform_launches.values():
    arguments = launch.get("args") if isinstance(launch, dict) else None
    if not isinstance(arguments, list) or not arguments:
        raise SystemExit("Generated ACP registry entry has no shim launch path")
    arguments[0] = install_shim
if registry_path.exists():
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
else:
    registry = {"version": "1.0.0", "agents": []}
if not isinstance(registry, dict) or not isinstance(registry.get("agents"), list):
    raise SystemExit(f"Invalid ACP registry structure: {registry_path}")

replace_ids = {entry["id"], "antigravity-devin"}
agents = registry["agents"]
insert_at = next(
    (index for index, agent in enumerate(agents)
     if isinstance(agent, dict) and agent.get("id") in replace_ids),
    len(agents),
)
registry["agents"] = [
    agent for agent in agents
    if not isinstance(agent, dict) or agent.get("id") not in replace_ids
]
registry["agents"].insert(min(insert_at, len(registry["agents"])), entry)
print(json.dumps(registry, indent=2))
PY
)

if (( dry_run )); then
    printf 'Dry run; no files changed.\nShim: %s\nRegistry: %s\n' "$install_shim" "$registry_path"
    printf '%s\n' "$registry_json"
    exit 0
fi

mkdir -p -- "$(dirname -- "$install_shim")" "$(dirname -- "$registry_path")"
shim_tmp=$(mktemp "${install_shim}.XXXXXX")
trap 'rm -f -- "$shim_tmp"' EXIT
cp -- "$source_shim" "$shim_tmp"
chmod 755 "$shim_tmp"
mv -f -- "$shim_tmp" "$install_shim"

"$python" - "$registry_path" "$registry_json" <<'PY'
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

registry_path = Path(sys.argv[1])
registry_json = json.dumps(json.loads(sys.argv[2]), indent=2) + "\n"
mode = stat.S_IMODE(registry_path.stat().st_mode) if registry_path.exists() else 0o644
fd, temporary_path = tempfile.mkstemp(prefix=f".{registry_path.name}.", dir=registry_path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as registry_file:
        registry_file.write(registry_json)
        registry_file.flush()
        os.fsync(registry_file.fileno())
    os.chmod(temporary_path, mode)
    os.replace(temporary_path, registry_path)
except BaseException:
    try:
        os.unlink(temporary_path)
    except FileNotFoundError:
        pass
    raise
PY
