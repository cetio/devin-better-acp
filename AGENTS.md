# Agents

## Verification

```sh
npm ci
npm run check                 # tsc --noEmit
npm test                      # build + unit tests (fake CLIs, no account access)
npm run package               # build the VSIX
```

`npm run test:integration` does not run under Devin Desktop (it never
forwards `--extensionTestsPath`); use the Extension Development Host or an
installed VSIX instead:

```sh
devin-desktop --user-data-dir=/tmp/devin-better-acp-dev --extensions-dir=/tmp/devin-better-acp-ext \
  --extensionDevelopmentPath="$PWD"
```

## Code intelligence

This repo uses Graphify only. Query the `graphify` MCP server
(`cetio/devin-better-acp`) — `query_graph` for questions, `graphify_find` for
definitions, `graphify_callers`/`graphify_callees`/`graphify_trace` for call
edges and paths, `graphify_impact` for blast radius, `graphify_tests_for` for
linked tests — before grep or reading whole files. Do not use CodeGraph even
if a `.codegraph/` directory exists.

## Layout

- `source/` extension TypeScript; `source/antigravity/` and `source/codex/`
  per-provider, shared helpers at the top level.
- `source/antigravity/acp.py` is the Python ACP shim; `source/mcp/` is the
  standalone MCP server (never imports Antigravity code).
- `tests/unit/` mirrors `source/`; fixtures in `tests/support.ts`; host
  checks in `tests/integration/`.

## Hard boundaries

- Codex is read via an ephemeral `codex app-server --stdio` that may only
  send `initialize`, `initialized`, `account/read`, `account/rateLimits/read`.
  Never start a thread or turn, log in or out, consume credits, or nudge.
- Antigravity is read with `agy --print /usage --output-format json
  --print-timeout 20s --mode plan`. Never pass `--disable-slash-commands` or
  reword `/usage`; stop polling on nonzero token usage.
- Never discover, read, copy, or refresh provider credentials; never write
  provider configuration or the installed provider executable. The temporary
  PAR launch copy is the only sanctioned patch, only through the validated
  `common_args` seam — never inject a user message instead.
- CLI output is untrusted: validate shapes, bound sizes, escape provider
  text in hover markdown, never surface raw stderr or API bodies.
- `Install Devin Better Antigravity` is the only write path to the Desktop
  ACP registry; it never writes provider config or credentials. Shim launch
  booleans live in `~/.config/devin/devin-better-antigravity.json`.
- The shim forwards only Antigravity's `default`/`auto_edit`/`yolo` modes
  unchanged, never emits `{type: "terminal"}` content blocks, and adds no
  dynamic plugin dispatch or compatibility wrappers.
- `npm run test:acp` is offline and part of `npm test`. Live Gemini checks
  need explicit authorization and an isolated workspace via
  `python3 tests/integration/acp.py --run-live`. Tests isolate HOME so local
  MCP config never affects the suite.

## Style

TypeScript per `~/Repos/autonom`: four-space indent, Allman braces, double
quotes, camelCase functions, PascalCase types, `ret` for returns, `source/`
for code, `dist/` for output. No comments unless they carry protocol
information names cannot.
