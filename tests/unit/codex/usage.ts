import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ConnectionState } from "../../../source/allowance/model";
import { createCodexAdapter, parseRateLimits } from "../../../source/providers/codex";
import { AdapterError, ProviderInvocation } from "../../../source/providers/adapter";
import { codexPool, codexRateLimits, codexServerScript, tempDir, writeScript } from "../../support";

const OBSERVED_AT = 1790000000000;

function invocation(script: string, directory: string, timeoutMs = 5000): ProviderInvocation
{
    return {
        command: script,
        readArgs: [],
        versionArgs: ["version"],
        cwd: directory,
        timeoutMs,
        versionTimeoutMs: 5000,
    };
}

test("codex rate limits map to labeled pools with metadata", () =>
{
    const result = parseRateLimits(codexRateLimits({ planType: "pro" }), OBSERVED_AT);

    assert.equal(result.observedAt, OBSERVED_AT);
    assert.equal(result.pools.length, 1);
    const pool = result.pools[0];
    assert.ok(pool !== undefined);
    assert.equal(pool.id, "codex");
    assert.equal(pool.label, "Codex");
    assert.deepEqual(pool.windows.map((window) => window.label), ["5h", "Weekly"]);
    assert.equal(pool.windows[0]?.usedPercent, 3);
    assert.equal(pool.windows[0]?.durationMinutes, 300);
    assert.equal(pool.windows[1]?.usedPercent, 16);
    assert.equal(pool.windows[1]?.resetsAt, 1893456000000);
    assert.deepEqual(result.metadata, [
        { label: "Plan", value: "Pro" },
        { label: "Extra credits", value: "None" },
    ]);
});

test("codex extra pools are preserved without replacing the primary pool", () =>
{
    const extra = {
        limitId: "codex_other",
        limitName: "GPT-5.1-Codex-Mini",
        primary: codexPool({ usedPercent: 42, durationMinutes: 60 }),
        secondary: null,
    };
    const result = parseRateLimits(codexRateLimits({ extraPools: { codex_other: extra } }), OBSERVED_AT);

    assert.deepEqual(result.pools.map((pool) => pool.id), ["codex", "codex_other"]);
    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 3);
    assert.equal(result.pools[1]?.label, "GPT-5.1-Codex-Mini");
    assert.equal(result.pools[1]?.windows[0]?.label, "1h");
});

test("codex falls back to the single-bucket view when the map is absent or empty", () =>
{
    const withoutMap = parseRateLimits(codexRateLimits({ includeByLimitId: false }), OBSERVED_AT);
    assert.equal(withoutMap.pools.length, 1);
    assert.equal(withoutMap.pools[0]?.id, "codex");

    const withEmptyMap = codexRateLimits();
    withEmptyMap.rateLimitsByLimitId = {};
    const empty = parseRateLimits(withEmptyMap, OBSERVED_AT);
    assert.equal(empty.pools.length, 1);
    assert.equal(empty.pools[0]?.windows.length, 2);
});

test("codex skips unusable windows and rejects empty pools", () =>
{
    const partial = codexRateLimits({ secondary: null, primary: codexPool({ usedPercent: 12.5 }) });
    const result = parseRateLimits(partial, OBSERVED_AT);
    assert.equal(result.pools[0]?.windows.length, 1);
    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 12.5);

    const invalid = codexRateLimits({ primary: { usedPercent: "many" }, secondary: { windowDurationMins: 300 } });
    assert.throws(() => parseRateLimits(invalid, OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);
});

test("codex keeps zero and over-limit usage values", () =>
{
    const result = parseRateLimits(codexRateLimits({
        primary: codexPool({ usedPercent: 0 }),
        secondary: codexPool({ usedPercent: 140, durationMinutes: 10080 }),
    }), OBSERVED_AT);

    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 0);
    assert.equal(result.pools[0]?.windows[1]?.usedPercent, 140);
});

test("the codex adapter sends only the allowlisted read-only requests", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const logPath = join(directory, "requests.log");
    const script = writeScript(directory, "codex.cjs", codexServerScript({
        account: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }, logPath));
    const adapter = createCodexAdapter(invocation(script, directory), "0.1.0");
    const result = await adapter.read(new AbortController().signal);

    assert.equal(result.pools[0]?.id, "codex");
    const requests = readFileSync(logPath, "utf8").trim().split("\n");
    const methods = requests.map((line) => (JSON.parse(line) as Record<string, unknown>).method);
    assert.deepEqual(methods, ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    const initialized = JSON.parse(requests[1] ?? "") as Record<string, unknown>;
    assert.equal(initialized.id, undefined);
    const account = JSON.parse(requests[2] ?? "") as Record<string, unknown>;
    assert.deepEqual(account.params, { refreshToken: false });
    assert.equal(requests.length, 4);
});

test("the codex adapter reports missing or non-ChatGPT logins truthfully", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const signedOut = writeScript(directory, "signed-out.cjs", codexServerScript({
        account: { account: null, requiresOpenaiAuth: true },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }));
    const signedOutAdapter = createCodexAdapter(invocation(signedOut, directory), "0.1.0");
    await assert.rejects(signedOutAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.AuthRequired);

    const apiKey = writeScript(directory, "api-key.cjs", codexServerScript({
        account: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }));
    const apiKeyAdapter = createCodexAdapter(invocation(apiKey, directory), "0.1.0");
    await assert.rejects(apiKeyAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);
});

test("the codex adapter classifies app-server errors", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const unsupported = writeScript(directory, "unsupported.cjs", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: { code: -32601, message: "method not found" },
        ignoreRequests: false,
    }));
    const unsupportedAdapter = createCodexAdapter(invocation(unsupported, directory), "0.1.0");
    await assert.rejects(unsupportedAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);

    const auth = writeScript(directory, "auth.cjs", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: { code: -32600, message: "chatgpt authentication required to read rate limits" },
        ignoreRequests: false,
    }));
    const authAdapter = createCodexAdapter(invocation(auth, directory), "0.1.0");
    await assert.rejects(authAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.AuthRequired);
});

test("a silent codex app-server fails as unavailable", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "silent.cjs", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: true,
    }));
    const adapter = createCodexAdapter(invocation(script, directory, 400), "0.1.0");
    await assert.rejects(adapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unavailable);
});

test("the codex adapter reports its version", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "codex.cjs", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }));
    const adapter = createCodexAdapter(invocation(script, directory), "0.1.0");
    assert.equal(await adapter.version(new AbortController().signal), "codex-cli 0.160.0");
});

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}
