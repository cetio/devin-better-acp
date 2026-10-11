# Agents

## Verification

```sh
npm ci
npm run check                 # tsc --noEmit
npm test                      # build + unit tests (fake CLIs, no account access)
npm run package               # build the VSIX
npm run package:files         # list the packaged files
```

`npm run test:integration` needs a host that forwards `--extensionTestsPath` to
the renderer. Devin Desktop 1.126 does not (its window configuration only
carries an `isExtensionTestHost` boolean), so the extension-host test module
never runs there. Do not work around this by patching the application or by
weakening Electron flags; use the Extension Development Host or an installed
VSIX for host verification instead.

Manual host check:

```sh
devin-desktop --user-data-dir=/tmp/devin-better-acp-dev --extensions-dir=/tmp/devin-better-acp-ext \
  --extensionDevelopmentPath="$PWD"
```

## Integration boundaries

- Codex is read through an ephemeral `codex app-server --stdio` that may only
  send `initialize`, `initialized`, `account/read`, and
  `account/rateLimits/read`. Never start a thread or turn, never log in or out,
  and never consume reset credits or send nudge emails.
- Antigravity is read with the standalone
  `agy --print /usage --output-format json --print-timeout 20s --mode plan`
  invocation. Never pass `--disable-slash-commands`, never reword `/usage` as a
  prompt, and stop polling if the envelope reports nonzero token usage.
- The extension never discovers, reads, copies, or refreshes provider
  credentials, and never writes to provider configuration.
- CLI output is untrusted: validate shapes, bound output size, keep provider
  text escaped in hover markdown, and never surface raw stderr or API bodies.
- Status items use the host's native status-bar, hover, and Quick Pick APIs with
  stable identifiers `devinBetterACP.codex` and `devinBetterACP.antigravity` so
  the application's own visibility controls keep working. Antigravity is one
  item that summarizes its Gemini and Other pools.
- `Install Devin Better Antigravity` is the only write path to the Desktop ACP
  registry. It installs the Python shim and integration modules and atomically
  replaces matching agent entries while preserving unrelated entries; it never
  writes provider configuration or credentials.

## ACP shim

`source/antigravity/acp.py` is the Python 3.10+ ACP entrypoint, separate from
read-only usage monitoring. It forwards sessions, MCP definitions, tools,
permissions, and client capabilities without rebuilding the conversation.
`bridge.py` owns subprocess lifecycle and stdio transport; `protocol.py` owns
bounded JSON-RPC framing. `translate.py` owns request correlation and explicit
lifecycle hooks (`CLIENT_HOOKS` maps ACP methods to handlers). `presentation/models.py` owns picker values; `appearance.py` owns permission-mode
labels and session titles; `questions.py` owns elicitation metadata and answer
correlation; `tools.py` owns tool output; `reads.py` correlates host file reads.
`mcp.py` translates Devin MCP config and integration launch entries into ACP
session parameters. State stays with its owning domain; do not add dynamic plugin
dispatch or compatibility wrappers.
The installer copies nested Python packages recursively and removes the obsolete
flat `antigravity/presentation.py` file when upgrading an earlier installation.

`source/mcp/server.py` is the standalone MCP entrypoint and dispatcher.
`source/mcp/tools.py` is the tool registration table. Implementations are split
by responsibility across `questions.py`, `commands.py`, and `files.py`; these MCP
modules do not import Antigravity-specific code. `source/mcp/channel.py` owns
the private socket,
session tokens, pending elicitation requests, cancellation, and shutdown.
`session/new` attaches local batch tools after ACP initialization even when the
client cannot render elicitation forms; `ask_user_question` is advertised only
when form elicitation is supported. It crosses this channel to the client's
`elicitation/create`. `batch_execute`, `batch_read`, `batch_edit`, `batch_search`,
and `batch_write` execute locally. Batches accept eight items. Output is bounded
(64 KiB per command stream, 256 KiB per read, 1 MiB per write/edit; search scans
at most 1000 files and 16 MiB per query and returns at most 50 matches). Exact
text edits require one match and leave that file unchanged otherwise. Execution
drains pipes into bounded buffers, timeouts kill the process group, and `DBA_*`
variables are not forwarded to child processes.
MCP stdio frames are capped at 16 MiB; local interaction frames at 1 MiB.

Question forms have exactly one property per question: string enums for single
select and array enums for multi-select. Native `cognition.ai/allowOther` and
`cognition.ai/otherOptionValue` metadata supply the Other composer; never create
extra Other or per-option boolean properties. Partial answers and skipped
questions are valid interaction results, not tool errors. Presentation matches
answers to one unambiguous pending question call within the same session and
records them before the MCP worker wakes. Tool state is keyed by session and
call ID, cleared on terminal updates and turn completion; pending interactions
are released on cancellation and shutdown. Tests isolate HOME and Path.home()
so local MCP configuration never affects the offline suite.
`--spoof-zed` changes only the downstream `initialize.clientInfo.name`;
`--registry-entry` prints a Desktop agent entry. Its `devin-better-antigravity`
ID opts into Desktop's Devin Local model picker. The shim maps decimal-version
model option IDs, Gemini 3 Flash IDs, Gemini 3.1 Pro High, and Claude Sonnet
4.6 Thinking to Devin catalog UIDs, then translates selections back to
Antigravity; unmatched IDs remain unchanged and are omitted by the
catalog-backed picker. Desktop owns picker sorting, pricing, and promo metadata;
ACP options cannot override those fields. Desktop may apply other `devin*`
connector behaviors to this agent. Server arguments follow `--`.

The shim identifies itself in-band as `Antigravity (DBA)`, appending a
`+devin-shim` version suffix to the upstream version. Upstream slash commands
pass through unchanged; there is no local `/devin-shim` command.
`--devin-config` merges MCP servers from `<workspace>/.devin/mcp_config*.json`,
`<workspace>/.devin/config.json`, and `~/.config/devin/` (JSONC tolerated) into
`session/new` and `session/load`, so Antigravity sees the same tools as Devin
Local; client-supplied `mcpServers` always win on name conflicts, `disabled`
entries are skipped, and the initialize result advertises
`_meta.mcpConfigPath` pointing at `~/.config/devin/mcp_config.json`.

Antigravity ACP 1.3 exposes only `default`, `auto_edit`, and `yolo` modes. The
shim preserves `Default` and displays Auto Edit as `Code` and YOLO as
`Bypass Permissions`, with Devin-style Lucide icons. It forwards original mode
values unchanged.
It does not advertise Smart, read-only Ask, or Plan modes: ACP 1.3 rejects those
mode IDs, and relabeling Default as Ask would misrepresent its permissions.

For rendering parity with Devin Local the shim synthesizes a
`session_info_update` (prompt-text title, once per session) since Antigravity
never emits one, and maps Antigravity `rawOutput` onto the Devin terminal
fields: `execute` `tool_call`s gain `_meta.terminal_info`, and
`tool_call_update`s gain `_meta.terminal_output` (`{terminal_id, data}` from
`combinedOutput`/`formatted_output`, or the raw string on failure) and
`_meta.terminal_exit` (`{terminal_id, exit_code}`) — the accumulated
`terminal_output.data` renders inline in `ExecuteToolCall`. Tool frames also
gain `_meta.cognition.ai/inferenceToolName` (`execute`→`exec`, `search`→`grep`,
other kinds pass through; `think`/`other`/`switch_mode` are skipped) matching
the field Devin Local puts on every tool frame. Do not add `{type: "terminal"}`
content blocks: they route rendering to the v2 terminal stream
(`terminal_update`/`terminal_output_chunk` events keyed by
`cognition.ai/eventId`), which the shim does not emit.

Measured against `devin acp` (SWE-2): Devin Local puts no stdout in frames
either — its exec calls stream the command into a `text/x-shellscript` preview
content block and report `"Exited with code N"`, while real output lives in the
client-owned terminal (`terminal/create`/`terminal/output` RPCs that
Antigravity never issues; it executes internally). For the `client_view_file`
path only, the shim correlates a successful host `fs/read_text_file` response
with exactly one pending read tool and completes it with the truthful line count;
ambiguous, failed, internal, and unmatched reads remain untouched. File contents
still pass directly to the provider through the existing `fs/*` response.

The registry `icon` must be an `http(s)` URL — Devin Desktop ignores `data:`
URIs and requires `Content-Type: image/svg+xml`. Its local-agent registry loader
fetches SVGs asynchronously (5-second timeout, 512-KiB maximum) and registers
the resulting data URL. `images/antigravity-acp.svg` is the white-fill mark
served via jsDelivr from `main`; update `--icon-url` if the repository URL
changes. The URL was verified to return HTTP 200, `image/svg+xml`, and the
white-fill asset. The Desktop extension host also re-registers the original
connector metadata when enabled-agent settings change, without retaining the
previously fetched icon; this can restore the generic icon. A persistent
fallback after a fresh registry load is a Desktop-side rendering/cache issue,
not fixed by rewriting ACP session frames.

`npm run test:acp` runs offline Python protocol tests and is included in
`npm test`. Live Gemini checks must be explicitly authorized and use an
isolated workspace; they are not part of automated verification. The shim
never reads credentials or provider configuration and never modifies the
installed provider executable. Provider stderr is drained but not exposed.

`prompt.py` contains the adapted Devin workspace `SYSTEM_PROMPT`.
`--system-prompt` opts into full replacement through the SDK's
`CustomSystemInstructions(text=...)`; the installer enables it by default.
The explicitly authorized workaround creates a private temporary PAR launch
copy and adds only `system_instructions` to the validated `common_args` seam.
It updates source and matching bytecode ZIP slots without moving entries or
changing file size: the native `elfzip` loader rejects appended/repacked layouts.
The Python interpreter must match the provider's bytecode magic (currently
CPython 3.14 for ACP 1.3.0). Unknown seams, incompatible bytecode, or insufficient
archive slots fail explicitly; never fall back to injecting a user message.
Original archive bytes, provider settings, credentials, and permission policies
remain untouched. The temporary copy is cleaned on normal exit and failures.
The original sibling harness remains the launch target. A model-free startup
check of this copy with `--only_check_args` passed on ACP 1.3.0; this is not a
live Gemini or Desktop UI verification.

An authorized live check uses `python3 tests/integration/acp.py --run-live`
(or adds `--registry <Desktop registry path>` to test the installed launch
entry). It selects an advertised Gemini model and verifies file edits,
command execution, MCP invocation, and permission round-trips in a temporary
workspace. `--run-live` is mandatory; the test never authenticates or changes
provider settings. Antigravity ACP 1.3.0 was verified with
`gemini-3.6-flash-low` and standard ACP v1 tool events.

## Style

TypeScript follows the conventions used in `~/Repos/autonom`: four-space
indentation, Allman braces, double quotes, camelCase functions, PascalCase
types, `ret` for explicit return values, `source/` for code, `tests/` for tests,
and `dist/` for build output. Group source modules by domain, mirror those
folders under `tests/unit/`, keep shared fixtures in `tests/support.ts`, and
put host checks in `tests/integration/`. Do not add comments unless they carry
protocol information that names cannot.
