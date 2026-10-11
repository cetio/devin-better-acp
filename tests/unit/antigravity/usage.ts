import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { ConnectionState } from "../../../source/allowance/model";
import { createAntigravityAdapter, parseUsageReport } from "../../../source/providers/antigravity";
import { AdapterError, ProviderInvocation } from "../../../source/providers/adapter";
import { PROVIDER_SPECS } from "../../../source/providers/registry";
import { agyScript, agyUsageReport, tempDir, writeScript } from "../../support";

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

test("antigravity usage maps Gemini and other-model pools separately", () =>
{
    const result = parseUsageReport(agyUsageReport(), OBSERVED_AT);

    assert.deepEqual(result.pools.map((pool) => pool.id), ["gemini", "other"]);
    const gemini = result.pools[0];
    assert.ok(gemini !== undefined);
    assert.equal(gemini.label, "Gemini Models");
    assert.equal(gemini.description, "Models within this group: Gemini Flash, Gemini Pro");
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

test("antigravity refuses a usage report that consumed model tokens", () =>
{
    assert.throws(() => parseUsageReport(agyUsageReport({ totalTokens: 12 }), OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);
});

test("antigravity requires the structured usage command envelope", () =>
{
    assert.throws(() => parseUsageReport(agyUsageReport({ includeCommand: false }), OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);
    const wrongCommand = { status: "SUCCESS", command: { name: "model" } };
    assert.throws(() => parseUsageReport(wrongCommand, OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);
    assert.throws(() => parseUsageReport(agyUsageReport({ groups: [] }), OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unavailable);
});

test("antigravity classifies failed usage commands", () =>
{
    const signedOut = { status: "ERROR", error: "authentication required" };
    assert.throws(() => parseUsageReport(signedOut, OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.AuthRequired);
    const offline = { status: "ERROR", error: "backend unavailable" };
    assert.throws(() => parseUsageReport(offline, OBSERVED_AT), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unavailable);
});

test("antigravity keeps unknown groups and skips unusable buckets", () =>
{
    const weekly = {
        id: "preview-weekly",
        name: "Weekly",
        window: "weekly",
        remaining_fraction: 0.5,
        reset_time: "not a date",
    };
    const groups = [
        {
            name: "Preview Models",
            buckets: [
                weekly,
                { id: "preview-broken", name: "Broken", window: "weekly", remaining_fraction: 1.5 },
            ],
        },
    ];
    const result = parseUsageReport(agyUsageReport({ groups }), OBSERVED_AT);

    assert.deepEqual(result.pools.map((pool) => pool.id), ["preview-models"]);
    assert.equal(result.pools[0]?.windows.length, 1);
    assert.equal(result.pools[0]?.windows[0]?.usedPercent, 50);
    assert.equal(result.pools[0]?.windows[0]?.resetsAt, undefined);
});

test("the antigravity adapter reads a successful report end to end", async (context) =>
{
    const directory = tempDir("devin-better-acp-agy-");
    context.after(() => removeDirectory(directory));
    const script = writeScript(directory, "agy.cjs", agyScript({}));
    const adapter = createAntigravityAdapter(invocation(script, directory));
    const result = await adapter.read(new AbortController().signal);

    assert.deepEqual(result.pools.map((pool) => pool.id), ["gemini", "other"]);
    assert.equal(await adapter.version(new AbortController().signal), "1.2.16");
});

test("the antigravity adapter classifies process failures", async (context) =>
{
    const directory = tempDir("devin-better-acp-agy-");
    context.after(() => removeDirectory(directory));
    const signedOutReport = agyScript({ exitCode: 1, stderr: "authentication required\n" });
    const signedOut = writeScript(directory, "signed-out.cjs", signedOutReport);
    const signedOutAdapter = createAntigravityAdapter(invocation(signedOut, directory));
    await assert.rejects(signedOutAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.AuthRequired);

    const broken = writeScript(directory, "broken.cjs", agyScript({ exitCode: 2, stderr: "boom\n" }));
    const brokenAdapter = createAntigravityAdapter(invocation(broken, directory));
    await assert.rejects(brokenAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unavailable);

    const garbled = writeScript(directory, "garbled.cjs", agyScript({ report: "not json" }));
    const garbledAdapter = createAntigravityAdapter(invocation(garbled, directory));
    await assert.rejects(garbledAdapter.read(new AbortController().signal), (error: unknown) =>
        error instanceof AdapterError && error.state === ConnectionState.Unsupported);
});

test("the provider specs lock the verified CLI invocations", () =>
{
    const codex = PROVIDER_SPECS.find((candidate) => candidate.id === "codex");
    const antigravity = PROVIDER_SPECS.find((candidate) => candidate.id === "antigravity");
    assert.ok(codex !== undefined && antigravity !== undefined);
    assert.deepEqual(codex.readArgs, ["app-server", "--stdio"]);
    const expected = ["--print", "/usage", "--output-format", "json", "--print-timeout", "20s", "--mode", "plan"];
    assert.deepEqual(antigravity.readArgs, expected);
    assert.equal(antigravity.readArgs.includes("--disable-slash-commands"), false);
    assert.equal(antigravity.readArgs.includes("--input-format"), false);
});

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}
