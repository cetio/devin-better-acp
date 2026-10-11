import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { antigravityCLI } from "../../../source/antigravity/cli";
import type { AntigravityConfig } from "../../../source/antigravity/config";
import { parseUsageReport } from "../../../source/antigravity/usage";
import type { CliContext } from "../../../source/cli";
import { ConnectionState, UsageError } from "../../../source/usage";
import { agyScript, agyUsageReport, tempDir, writeScript } from "../../support";

function config(script: string): AntigravityConfig
{
    return {
        id: "antigravity",
        label: "Antigravity",
        enabled: true,
        path: script,
        visible: true,
        spoofZed: true,
        devinMcp: true,
        systemPrompt: true,
        cli: antigravityCLI,
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

test("Antigravity usage maps Gemini and Other pools without retaining unused descriptions", () =>
{
    const result = parseUsageReport(agyUsageReport());

    assert.equal(result.partial, false);
    assert.deepEqual(result.pools.map((pool) => pool.id), ["gemini", "other"]);
    const gemini = result.pools[0];
    assert.ok(gemini !== undefined);
    assert.equal(gemini.label, "Gemini Models");
    assert.deepEqual(gemini.windows.map((window) => window.id), ["gemini-5h", "gemini-weekly"]);
    assert.equal(gemini.windows[0]?.label, "5h");
    assert.equal(gemini.windows[0]?.durationMinutes, 300);
    assert.ok(Math.abs((gemini.windows[0]?.usedPercent ?? 0) - 1.01000070571899) < 1e-9);
    assert.equal(gemini.windows[1]?.label, "Weekly");
    assert.equal(gemini.windows[1]?.durationMinutes, 10080);
    assert.equal(gemini.windows[1]?.resetsAt, Date.parse("2030-05-11T01:32:38Z"));
    assert.ok(Math.abs((gemini.windows[1]?.usedPercent ?? 0) - 0.62833428382874) < 1e-9);

    const other = result.pools[1];
    assert.ok(other !== undefined);
    assert.equal(other.label, "Claude and GPT models");
    assert.equal(other.windows[0]?.usedPercent, 0);
    assert.equal(other.windows[1]?.usedPercent, 0);
});

test("positive token counters stop polling before status or command parsing", () =>
{
    const tokenKeys = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
    for (const key of tokenKeys)
    {
        const payload = { status: "ERROR", error: "PRIVATE", usage: { [key]: 1 } };
        assert.throws(() => parseUsageReport(payload), (error: unknown) =>
            error instanceof UsageError && error.state === ConnectionState.Unsupported
                && error.stopPolling && !error.message.includes("PRIVATE"));
    }
});

test("Antigravity requires the structured usage command envelope", () =>
{
    assert.throws(() => parseUsageReport(agyUsageReport({ includeCommand: false })), (error: unknown) =>
        error instanceof UsageError && error.state === ConnectionState.Unsupported);
    const wrongCommand = { status: "SUCCESS", command: { name: "model" } };
    assert.throws(() => parseUsageReport(wrongCommand), (error: unknown) =>
        error instanceof UsageError && error.state === ConnectionState.Unsupported);
    assert.throws(() => parseUsageReport(agyUsageReport({ groups: [] })), (error: unknown) =>
        error instanceof UsageError && error.state === ConnectionState.Unavailable);
});

test("Antigravity classifies failed usage commands without surfacing response bodies", () =>
{
    const signedOut = { status: "ERROR", error: "authentication required PRIVATE" };
    assert.throws(() => parseUsageReport(signedOut), (error: unknown) =>
        error instanceof UsageError && error.state === ConnectionState.AuthRequired
            && !error.message.includes("PRIVATE"));
    const offline = { status: "ERROR", error: "backend unavailable PRIVATE" };
    assert.throws(() => parseUsageReport(offline), (error: unknown) =>
        error instanceof UsageError && error.state === ConnectionState.Unavailable
            && !error.message.includes("PRIVATE"));
});

test("Antigravity marks missing pools partial and skips unusable buckets", () =>
{
    const weekly = {
        id: "preview-weekly",
        name: "Weekly",
        window: "weekly",
        remaining_fraction: 0.5,
        reset_time: "not a date",
    };
    const groups = [{
        name: "Preview Models",
        buckets: [weekly, { id: "preview-broken", name: "Broken", window: "weekly", remaining_fraction: 1.5 }],
    }];
    const result = parseUsageReport(agyUsageReport({ groups }));

    assert.equal(result.partial, true);
    assert.deepEqual(result.pools.map((pool) => pool.id), ["preview-models"]);
    assert.equal(result.pools[0]?.windows.length, 1);
    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 50);
    assert.equal(result.pools[0]?.windows[0]?.resetsAt, undefined);
});

test("the Antigravity CLI runs only the standalone slash-usage command", async (context) =>
{
    const directory = tempDir("devin-better-acp-agy-");
    context.after(() => removeDirectory(directory));
    const logPath = join(directory, "arguments.log");
    const script = writeScript(directory, "agy.cjs", agyScript({ logPath }));
    const report = await antigravityCLI.readUsage(config(script), cliContext(directory), new AbortController().signal);

    assert.deepEqual(report.pools.map((pool) => pool.id), ["gemini", "other"]);
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split(" "), [
        "--print", "/usage", "--output-format", "json", "--print-timeout", "20s", "--mode", "plan",
    ]);
    assert.equal(readFileSync(logPath, "utf8").includes("--disable-slash-commands"), false);
    assert.equal(readFileSync(logPath, "utf8").includes("--version"), false);
});

test("the Antigravity CLI classifies process and JSON failures safely", async (context) =>
{
    const directory = tempDir("devin-better-acp-agy-");
    context.after(() => removeDirectory(directory));
    const signedOut = writeScript(
        directory,
        "signed-out.cjs",
        agyScript({ exitCode: 1, stderr: "authentication required PRIVATE" }),
    );
    await assert.rejects(
        antigravityCLI.readUsage(config(signedOut), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.AuthRequired
            && !error.message.includes("PRIVATE"),
    );

    const broken = writeScript(directory, "broken.cjs", agyScript({ exitCode: 2, stderr: "boom PRIVATE" }));
    await assert.rejects(
        antigravityCLI.readUsage(config(broken), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.Unavailable
            && !error.message.includes("PRIVATE"),
    );

    const garbled = writeScript(directory, "garbled.cjs", agyScript({ report: "not json" }));
    await assert.rejects(
        antigravityCLI.readUsage(config(garbled), cliContext(directory), new AbortController().signal),
        (error: unknown) => error instanceof UsageError && error.state === ConnectionState.Unsupported,
    );
});
