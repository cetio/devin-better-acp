import { ConnectionState, ProviderSnapshot, ProviderStatus, UsagePool, UsageWindow } from "../source/usage";
import type { DisplayContext } from "../source/ui/status";
import type { UsageState } from "../source/usage";

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tempDir(prefix: string): string
{
    return mkdtempSync(join(tmpdir(), prefix));
}

export function writeScript(directory: string, fileName: string, body: string): string
{
    const path = join(directory, fileName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
}

export type CodexFixture = {
    account: unknown;
    rateLimits: unknown;
    rpcError: { code: number; message: string } | undefined;
    ignoreRequests: boolean;
    launchLogPath?: string;
};

export function codexServerScript(fixture: CodexFixture, logPath?: string): string
{
    return `
const readline = require("node:readline");
const fs = require("node:fs");
const fixture = ${JSON.stringify(fixture)};
const logPath = ${JSON.stringify(logPath ?? "")};
const launchLogPath = fixture.launchLogPath || "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (launchLogPath) {
    fs.appendFileSync(launchLogPath, process.argv.slice(2).join(" "));
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return;
    }
    if (logPath) {
        fs.appendFileSync(logPath, JSON.stringify(message) + "\\n");
    }
    if (fixture.ignoreRequests) {
        return;
    }
    if (message.id === undefined) {
        return;
    }
    if (message.method === "initialize") {
        send({ id: message.id, result: { userAgent: "fake", platformFamily: "unix", platformOs: "linux" } });
        return;
    }
    if (message.method === "account/read") {
        send({ id: message.id, result: fixture.account });
        return;
    }
    if (message.method === "account/rateLimits/read") {
        if (fixture.rpcError) {
            send({ id: message.id, error: fixture.rpcError });
        } else {
            send({ id: message.id, result: fixture.rateLimits });
        }
        return;
    }
    send({ id: message.id, error: { code: -32601, message: "method not found" } });
});
`;
}

export type AgyFixture = {
    report: unknown;
    exitCode: number;
    stderr: string;
    logPath: string;
};

export function agyScript(fixture: Partial<AgyFixture>): string
{
    const resolved: AgyFixture = {
        report: fixture.report ?? agyUsageReport(),
        exitCode: fixture.exitCode ?? 0,
        stderr: fixture.stderr ?? "",
        logPath: fixture.logPath ?? "",
    };
    return `
const fs = require("node:fs");
const fixture = ${JSON.stringify(resolved)};

if (fixture.logPath) {
    fs.appendFileSync(fixture.logPath, process.argv.slice(2).join(" ") + "\\n");
}
if (fixture.stderr.length > 0) {
    process.stderr.write(fixture.stderr);
}
if (typeof fixture.report === "string") {
    process.stdout.write(fixture.report);
} else {
    process.stdout.write(JSON.stringify(fixture.report));
}
process.exit(fixture.exitCode);
`;
}

export function codexPool(
    options: { usedPercent?: number; durationMinutes?: number; resetsAt?: number } = {},
): Record<string, unknown>
{
    return {
        usedPercent: options.usedPercent ?? 3,
        windowDurationMins: options.durationMinutes ?? 300,
        resetsAt: options.resetsAt ?? 1893456000,
    };
}

export function codexRateLimits(options: {
    primary?: Record<string, unknown> | null;
    secondary?: Record<string, unknown> | null;
    planType?: string;
    credits?: Record<string, unknown>;
    rateLimitReachedType?: string | null;
    spendControlReached?: boolean;
    extraPools?: Record<string, unknown>;
    includeByLimitId?: boolean;
} = {}): Record<string, unknown>
{
    const secondary = codexPool({ usedPercent: 16, durationMinutes: 10080 });
    const pool: Record<string, unknown> = {
        limitId: "codex",
        limitName: null,
        primary: options.primary === undefined ? codexPool() : options.primary,
        secondary: options.secondary === undefined ? secondary : options.secondary,
        credits: options.credits ?? { hasCredits: false, unlimited: false, balance: "0" },
        planType: options.planType ?? "plus",
        rateLimitReachedType: options.rateLimitReachedType ?? null,
        spendControlReached: options.spendControlReached ?? false,
    };
    const ret: Record<string, unknown> = { rateLimits: pool };
    if (options.includeByLimitId !== false)
        ret.rateLimitsByLimitId = { codex: pool, ...(options.extraPools ?? {}) };
    return ret;
}

export function agyBucket(
    id: string,
    name: string,
    window: string,
    remaining: number,
    resetTime: string,
): Record<string, unknown>
{
    return { id, name, window, remaining_fraction: remaining, reset_time: resetTime };
}

export function agyUsageReport(options: {
    geminiWeekly?: number;
    geminiFiveHour?: number;
    otherWeekly?: number;
    otherFiveHour?: number;
    totalTokens?: number;
    includeCommand?: boolean;
    groups?: unknown[];
} = {}): Record<string, unknown>
{
    const usage = {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: options.totalTokens ?? 0,
    };
    const groups = options.groups ?? [
        {
            name: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [
                agyBucket(
                    "gemini-weekly",
                    "Weekly Limit Remaining",
                    "weekly",
                    options.geminiWeekly ?? 0.9937166571617126,
                    "2030-05-11T01:32:38Z",
                ),
                agyBucket(
                    "gemini-5h",
                    "Five Hour Limit Remaining",
                    "5h",
                    options.geminiFiveHour ?? 0.9898999929428101,
                    "2030-05-04T06:32:38Z",
                ),
            ],
        },
        {
            name: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
                agyBucket(
                    "3p-weekly",
                    "Weekly Limit Remaining",
                    "weekly",
                    options.otherWeekly ?? 1,
                    "2030-05-11T02:22:18Z",
                ),
                agyBucket(
                    "3p-5h",
                    "Five Hour Limit Remaining",
                    "5h",
                    options.otherFiveHour ?? 1,
                    "2030-05-04T07:22:18Z",
                ),
            ],
        },
    ];
    const ret: Record<string, unknown> = { status: "SUCCESS", response: "", usage };
    if (options.includeCommand !== false)
        ret.command = { name: "usage", data: { description: "", groups } };
    return ret;
}

export const TEST_NOW = 1000;
export const TEST_CONTEXT: DisplayContext = { now: TEST_NOW, staleAfterMs: 600000 };

export function testUsageState(statuses: ProviderStatus[]): UsageState
{
    return { statuses, now: TEST_NOW, staleAfterMs: TEST_CONTEXT.staleAfterMs };
}

export function testWindow(
    id: string,
    label: string,
    usedPercent: number,
    durationMinutes?: number,
    resetsAt?: number,
): UsageWindow
{
    return { id, label, usedPercent, durationMinutes, resetsAt };
}

export function testPool(id: string, label: string, windows: UsageWindow[]): UsagePool
{
    return { id, label, windows };
}

export function testSnapshot(usedPercent: number): ProviderSnapshot
{
    return {
        pools: [testPool("codex", "Codex", [testWindow("codex:primary", "5h", usedPercent, 300)])],
        metadata: [],
    };
}

export function testStatus(changes: Partial<ProviderStatus> = {}): ProviderStatus
{
    return {
        provider: "codex",
        label: "Codex",
        state: ConnectionState.Ready,
        message: undefined,
        snapshot: {
            pools: [testPool("codex", "Codex", [
                testWindow("codex:primary", "5h", 3, 300, TEST_NOW + 4 * 3600000),
                testWindow("codex:secondary", "Weekly", 16, 10080, TEST_NOW + 6 * 86400000 + 6 * 3600000),
            ])],
            metadata: [{ label: "Plan", value: "plus" }],
        },
        refreshing: false,
        lastSuccessAt: TEST_NOW - 100,
        ...changes,
    };
}

export function testAntigravityStatus(changes: Partial<ProviderStatus> = {}): ProviderStatus
{
    return testStatus({
        provider: "antigravity",
        label: "Antigravity",
        snapshot: {
            pools: [
                testPool("gemini", "Gemini Models", [
                    testWindow("gemini-5h", "5h", 3, 300, TEST_NOW + 4 * 3600000),
                    testWindow("gemini-weekly", "weekly", 16, 10080, TEST_NOW + 6 * 86400000 + 6 * 3600000),
                ]),
                testPool("other", "Claude and GPT models", [testWindow("3p-5h", "5h", 0, 300)]),
            ],
            metadata: [],
        },
        ...changes,
    });
}
