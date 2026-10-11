# Devin Better ACP

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE.txt)

Devin Better ACP is a Devin Desktop extension that provides better ACP functionality for
Codex and Antigravity, with UI for usage and reset information, and a custom
Devin-style Antigravity ACP.

> *To install the ACP, first install the extension and then run the ACP install command.*

## Requirements

| Requirement | Notes |
| --- | --- |
| Devin Desktop | 1.90 or newer on Linux, or a VS Code-compatible host |
| `codex` | Signed in with a ChatGPT plan (`codex login`) |
| `agy` | Signed in (`agy`) |

Both CLIs are resolved from `PATH`, `~/.local/bin`, or an explicit absolute path
in settings. The extension never reads, copies, or refreshes stored credentials.
Each CLI uses its own login and its own network calls.

## Installation

Build the VSIX and install it:

```sh
npm ci
npm run package
devin-desktop --install-extension bin/devin-better-acp-1.0.0.vsix
```

Reload the window after installing.

## Usage

| Surface | Behaviour |
| --- | --- |
| Status bar | One labelled item per provider with no percentage. The native warning or error background tracks its most-used limit. |
| Hover | Codex shows its windows on one line; Antigravity shows Gemini and Other pools separately, with a muted stale-data note when needed. |
| Click | Opens the native Quick Pick focused on that provider. Antigravity includes both pools; each limit row shows usage and reset time. |
| Navigation | Back steps from the settings page to the provider, then to the overview. |
| Refresh | The toolbar refresh updates the selected provider. The overview refreshes both. |

Antigravity meters Gemini and the Claude and GPT models as separate pools.
Codex shows its plan and credit metadata under Details. Missing usage values stay
missing and stale results are labelled rather than shown as zero.

The status items use stable identifiers (`devinBetterACP.codex` and
`devinBetterACP.antigravity`), so the host's own hide and show menu and the
visibility settings both work.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `devinBetterACP.codex.enabled` | `true` | Enable the Codex provider |
| `devinBetterACP.codex.path` | empty | Absolute path to `codex` |
| `devinBetterACP.antigravity.enabled` | `true` | Enable the Antigravity provider |
| `devinBetterACP.antigravity.path` | empty | Absolute path to `agy` |
| `devinBetterACP.refreshIntervalSeconds` | `180` | Fixed background polling interval, including while unfocused. `0` disables background polling; positive values below 60 seconds are allowed. |
| `devinBetterACP.antigravity.spoofZed` | `true` | Send the Zed client name to Antigravity for compatibility. |
| `devinBetterACP.antigravity.devinMcp` | `true` | Merge Devin MCP servers into Antigravity sessions. |
| `devinBetterACP.antigravity.systemPrompt` | `true` | Use the adapted system prompt in a temporary Antigravity launch copy. |
| `devinBetterACP.statusBar.alignment` | `right` | Status-bar side |
| `devinBetterACP.statusBar.showCodex` | `true` | Show the Codex item |
| `devinBetterACP.statusBar.showAntigravity` | `true` | Show the Antigravity item |

Usage refreshes start when the extension activates, then run on one fixed,
configurable cadence regardless of window focus. Ordinary failures retry on the
next interval while the last successful values remain marked stale. If the
Antigravity probe reports model-token consumption, its polling stops until you
explicitly reconnect. Usage monitoring is paused in untrusted workspaces.

Antigravity shim settings are synchronized to an extension-owned file under
`~/.config/devin/`. After the one-time confirmed install/update, setting changes
apply to new ACP launches after running `Devin: Reload ACP Connections`. The
snapshot is shared by installed connectors in the same user home.

## Commands

| Command | Purpose |
| --- | --- |
| `Devin Better ACP: Show Usage` | Open the details and actions menu |
| `Devin Better ACP: Refresh All` | Refresh both providers now |
| `Devin Better ACP: Retry Connection` | Explicitly retry a provider, including resuming a token-safety stop |
| `Devin Better ACP: Configure CLI Path` | Pick the CLI executable and store its absolute path |
| `Devin Better ACP: Open Settings` | Open the extension settings |
| `Devin Better ACP: Open ChatGPT Usage Page` | Open the account usage page for Codex |
| `Devin Better ACP: Install Devin Better Antigravity` | Copy the ACP shim and update the local agent registry |

The installer confirms before writing, copies the shim to `~/.local/lib/devin-better-acp`,
and merges the agent into `~/.windsurf/acp/registry.json`. The default Antigravity
ACP server path is `~/.local/opt/agy-acp/current/agy_acp_server.par`; existing
matching entries are replaced and unrelated entries are preserved. Run
`Devin: Reload ACP Connections` after installation to load the new entry.
`DEVIN_BETTER_ACP_INSTALL_DIR`,
`AGY_ACP_SERVER_PATH`, `DEVIN_ACP_REGISTRY_PATH`, and `PYTHON` override defaults.

## How It Works

| Provider | Read-only integration | Verified on |
| --- | --- | --- |
| Codex | Ephemeral `codex app-server --stdio` with `initialize`, `account/read`, and `account/rateLimits/read` | codex-cli 0.160.0 |
| Antigravity | `agy --print /usage --output-format json --print-timeout 20s --mode plan` | agy 1.2.16 |

The Codex connection only performs those read requests and never starts a
thread or a turn. The Antigravity invocation is a standalone slash command that is expected to
report zero model tokens. Polling stops if any usage counter is positive.

## Development

```sh
npm ci
npm run check          # type check
npm test               # type check + unit tests with fake CLIs
npm run package        # build and produce the VSIX
npm run package:files  # list the files that would ship
```

Unit tests run generated fake `codex` and `agy` executables from a temporary
directory. They never touch your real accounts.

`npm run test:integration` needs a host that forwards `--extensionTestsPath` to
the renderer. Devin Desktop 1.126 does not, so use the Extension Development
Host or an installed VSIX for manual verification:

```sh
devin-desktop --user-data-dir=/tmp/devin-better-acp-dev --extensions-dir=/tmp/devin-better-acp-ext \
  --extensionDevelopmentPath="$PWD"
```

Load the extension and confirm the items match `agy`'s `/usage` panel and the
Codex usage page for the same account.

## Antigravity ACP Integration

The installer deploys the shim and its MCP modules and enables the adapted
Devin workspace system prompt. Protocol translation lives in
`source/antigravity/translate.py`; model mapping, question UI, permission-mode
appearance, and tool rendering are grouped under `source/antigravity/presentation/`.
Integration tools are defined and registered in
`source/mcp/tools.py`, separate from the MCP server transport.

Structured questions use the Desktop's native multi-select and Other composer,
without extra form pages. The integration supplies batch command execution,
reads, unique-anchor text edits, literal text search with path/glob filters, and
full-file writes. Use those tools for parallel commands, multi-file inspection,
workspace searches, and exact multi-file patches; use native ACP editing for
structural changes. Batches are bounded, and ambiguous edits leave a file
untouched. Configured Devin MCP servers continue through ACP session setup.

`source/antigravity/prompt.py` defines `SYSTEM_PROMPT`. Direct launches opt in
with `--system-prompt`; omitting it retains the upstream prompt. Replacement
uses `CustomSystemInstructions` in a private temporary copy of the provider PAR,
preserving its native layout and updating both source and bytecode. The original
executable, provider settings, and credentials are untouched. The launch copy
requires Python matching the provider's bytecode version (CPython 3.14 for the
verified ACP 1.3.0 build), and unsupported provider layouts fail explicitly.
`--spoof-zed` changes the downstream client name without patching the installation.

## License

Devin Better ACP is licensed under [MIT](LICENSE.txt).
