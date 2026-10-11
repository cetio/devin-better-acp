import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { codexCLI } from "../../../source/codex/cli";
import type { CodexConfig } from "../../../source/codex/config";
import { parseRateLimits } from "../../../source/codex/usage";
import { ConnectionState, UsageError } from "../../../source/usage";
import type { CliContext } from "../../../source/cli";
import { codexPool, codexRateLimits, codexServerScript, tempDir, writeScript } from "../../support";

function config(script: string): CodexConfig
{
    return {
        id: "codex",
        label: "Codex",
        enabled: true,
        path: script,
        visible: true,
        cli: codexCLI,
    };
}

function cliContext(directory: string): CliContext
{
    return {
        workingDirectory: directory,
        workspacePaths: [],
        environment: { PATH: "" },
        home: directory,
        clientVersion: "0.1.0",
    };
}

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}

test("Codex rate limits map to labeled pools with metadata", () =>
{
    const result = parseRateLimits(codexRateLimits({ planType: "pro" }));

    assert.equal(result.partial, false);
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

test("Codex preserves extra pools and their limit labels", () =>
{
    const extra = {
        limitId: "codex_other",
        limitName: "GPT-5.1-Codex-Mini",
        primary: codexPool({ usedPercent: 42, durationMinutes: 60 }),
        secondary: null,
    };
    const result = parseRateLimits(codexRateLimits({ extraPools: { codex_other: extra } }));

    assert.deepEqual(result.pools.map((pool) => pool.id), ["codex", "codex_other"]);
    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 3);
    assert.equal(result.pools[1]?.label, "GPT-5.1-Codex-Mini");
    assert.equal(result.pools[1]?.windows[0]?.label, "1h");
});

test("Codex falls back to the single-pool view when its pool map is absent or empty", () =>
{
    const withoutMap = parseRateLimits(codexRateLimits({ includeByLimitId: false }));
    assert.equal(withoutMap.pools.length, 1);
    assert.equal(withoutMap.pools[0]?.id, "codex");

    const withEmptyMap = codexRateLimits();
    withEmptyMap.rateLimitsByLimitId = {};
    const empty = parseRateLimits(withEmptyMap);
    assert.equal(empty.pools.length, 1);
    assert.equal(empty.pools[0]?.windows.length, 2);
});

test("Codex skips unusable windows and rejects empty pools", () =>
{
    const partial = codexRateLimits({ secondary: null, primary: codexPool({ usedPercent: 12.5 }) });
    const result = parseRateLimits(partial);
    assert.equal(result.pools[0]?.windows.length, 1);
    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 12.5);

    const invalid = codexRateLimits({ primary: { usedPercent: "many" }, secondary: { windowDurationMins: 300 } });
    assert.throws(() => parseRateLimits(invalid), (error: unknown) =>
        error instanceof UsageError && error.state === ConnectionState.Unsupported);
});

test("Codex preserves zero and over-limit usage values", () =>
{
    const result = parseRateLimits(codexRateLimits({
        primary: codexPool({ usedPercent: 0 }),
        secondary: codexPool({ usedPercent: 140, durationMinutes: 10080 }),
    }));

    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 0);
    assert.equal(result.pools[0]?.windows[1]?.usedPercent, 140);
});

test("the Codex CLI sends only the allowlisted read-only requests", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const logPath = join(directory, "requests.log");
    const launchLogPath = join(directory, "launch-args.log");
    const script = writeScript(directory, "codex.cjs", codexServerScript({
        account: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
        launchLogPath,
    }, logPath));
    const report = await codexCLI.readUsage(config(script), cliContext(directory), new AbortController().signal);

    assert.equal(report.pools[0]?.id, "codex");
    const requests = readFileSync(logPath, "utf8").trim().split("\n");
    const messages = requests.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(messages.map((message) => message.method), [
        "initialize", "initialized", "account/read", "account/rateLimits/read",
    ]);
    assert.equal((messages[0]?.params as { clientInfo: { version: string } }).clientInfo.version, "0.1.0");
    assert.deepEqual(messages[2]?.params, { refreshToken: false });
    assert.equal(requests.length, 4);
    const launchArgs = readFileSync(launchLogPath, "utf8");
    assert.equal(launchArgs, "app-server --stdio");
    assert.equal(launchArgs.includes("--version"), false);
});

test("Codex reports missing and non-ChatGPT accounts without exposing response bodies", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const signedOut = writeScript(directory, "signed-out.cjs", codexServerScript({
        account: { account: null, requiresOpenaiAuth: true },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }));
    await assert.rejects(
        codexCLI.readUsage(config(signedOut), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.AuthRequired,
    );

    const apiKey = writeScript(directory, "api-key.cjs", codexServerScript({
        account: { account: { type: "apiKey", token: "PRIVATE" } },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }));
    await assert.rejects(
        codexCLI.readUsage(config(apiKey), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.Unsupported
            && !error.message.includes("PRIVATE"),
    );
});

test("Codex classifies RPC failures without showing provider error bodies", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const unsupported = writeScript(directory, "unsupported.cjs", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: { code: -32601, message: "method not found PRIVATE" },
        ignoreRequests: false,
    }));
    await assert.rejects(
        codexCLI.readUsage(config(unsupported), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.Unsupported
            && !error.message.includes("PRIVATE"),
    );

    const auth = writeScript(directory, "auth.cjs", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: { code: -32600, message: "authentication required PRIVATE" },
        ignoreRequests: false,
    }));
    await assert.rejects(
        codexCLI.readUsage(config(auth), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.AuthRequired
            && !error.message.includes("PRIVATE"),
    );
});

test("the Codex CLI rediscovers an executable on each read", async (context) =>
{
    const directory = tempDir("devin-better-acp-codex-");
    context.after(() => removeDirectory(directory));
    const commandDirectory = join(directory, "bin");
    const invocation = { ...cliContext(directory), environment: { PATH: commandDirectory } };
    const settings = config("");
    await assert.rejects(
        codexCLI.readUsage(settings, invocation, new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.MissingCli,
    );

    writeScript(commandDirectory, "codex", codexServerScript({
        account: { account: { type: "chatgpt" } },
        rateLimits: codexRateLimits(),
        rpcError: undefined,
        ignoreRequests: false,
    }));
    const result = await codexCLI.readUsage(settings, invocation, new AbortController().signal);
    assert.equal(result.pools[0]?.id, "codex");
});
