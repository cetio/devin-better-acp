import { runCli } from "../process/runner";
import { compareWindows } from "../allowance/format";
import { ConnectionState, UsagePool, UsageWindow } from "../allowance/model";
import {
    AdapterError,
    AdapterResult,
    ProviderAdapter,
    ProviderInvocation,
    classifyExit,
    probeVersion,
} from "./adapter";
import { asNumber, asRecord, asString } from "./envelope";

const MAX_STDOUT_BYTES = 1024 * 1024;
const TOKEN_COUNTER_KEYS = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
const SIGN_IN_MESSAGE = "Antigravity CLI is not signed in. Run `agy`, sign in, then retry.";

export function createAntigravityAdapter(invocation: ProviderInvocation): ProviderAdapter
{
    return {
        id: "antigravity",
        label: "Antigravity",
        command: invocation.command,
        readArgs: invocation.readArgs,
        minimumVersion: { major: 1, minor: 2, patch: 16 },
        version: (signal) => probeVersion(invocation, signal),
        read: (signal) => readUsage(invocation, signal),
    };
}

async function readUsage(invocation: ProviderInvocation, signal: AbortSignal): Promise<AdapterResult>
{
    const result = await runCli({
        command: invocation.command,
        args: invocation.readArgs,
        cwd: invocation.cwd,
        timeoutMs: invocation.timeoutMs,
        maxStdoutBytes: MAX_STDOUT_BYTES,
    }, signal);
    if (result.exit.spawnError !== undefined)
        throw classifyExit(result.exit, "Antigravity CLI");
    if (result.exit.timedOut || result.exit.aborted || result.exit.code !== 0)
    {
        if (/auth|login|credential|signed in/i.test(result.stderr))
            throw new AdapterError(ConnectionState.AuthRequired, SIGN_IN_MESSAGE);
        throw classifyExit(result.exit, "Antigravity CLI");
    }
    let payload: unknown;
    try
    {
        payload = JSON.parse(result.stdout);
    }
    catch
    {
        throw new AdapterError(ConnectionState.Unsupported, "Antigravity CLI returned an unreadable usage report.");
    }
    return parseUsageReport(payload, Date.now());
}

export function parseUsageReport(payload: unknown, observedAt: number): AdapterResult
{
    const root = asRecord(payload);
    if (root === undefined)
        throw new AdapterError(ConnectionState.Unsupported, "Antigravity CLI returned an unreadable usage report.");
    const status = asString(root.status);
    if (status !== undefined && status !== "SUCCESS")
    {
        const error = asString(root.error);
        if (error !== undefined && /auth|login|credential|signed in/i.test(error))
            throw new AdapterError(ConnectionState.AuthRequired, SIGN_IN_MESSAGE);
        const failure = `Antigravity usage command failed (${status}).`;
        const detail = error === undefined ? failure : `Antigravity usage command failed: ${error}`;
        throw new AdapterError(ConnectionState.Unavailable, detail);
    }
    const command = asRecord(root.command);
    const commandName = command === undefined ? undefined : asString(command.name);
    if (commandName !== "usage")
    {
        const message = "Antigravity CLI did not answer the usage command. Update the CLI, then retry.";
        throw new AdapterError(ConnectionState.Unsupported, message);
    }
    assertNoTokensConsumed(root.usage);
    const data = asRecord(command?.data) ?? asRecord(root.data);
    const groups = data === undefined || !Array.isArray(data.groups) ? [] : data.groups;
    if (groups.length === 0)
        throw new AdapterError(ConnectionState.Unavailable, "Antigravity reported no quota groups.");
    const pools = new Map<string, UsagePool>();
    for (const groupValue of groups)
    {
        const group = asRecord(groupValue);
        if (group === undefined)
            continue;
        const groupName = asString(group.name) ?? "Antigravity";
        const description = asString(group.description);
        const buckets = Array.isArray(group.buckets) ? group.buckets : [];
        for (const bucketValue of buckets)
        {
            const bucket = asRecord(bucketValue);
            if (bucket === undefined)
                continue;
            const bucketId = asString(bucket.id) ?? asString(bucket.name);
            const remaining = asNumber(bucket.remaining_fraction);
            if (bucketId === undefined || remaining === undefined || remaining < -1e-9 || remaining > 1 + 1e-9)
                continue;
            const windowText = asString(bucket.window);
            const window: UsageWindow = {
                id: bucketId,
                label: windowLabel(windowText, bucketId),
                usedPercent: (1 - Math.min(Math.max(remaining, 0), 1)) * 100,
                durationMinutes: parseWindowMinutes(windowText),
                resetsAt: parseResetTime(bucket.reset_time),
            };
            const poolId = bucketPoolId(bucketId) ?? groupPoolId(groupName) ?? slug(groupName);
            const pool = pools.get(poolId);
            if (pool === undefined)
                pools.set(poolId, { id: poolId, label: groupName, description, windows: [window] });
            else
                pool.windows.push(window);
        }
    }
    if (pools.size === 0)
        throw new AdapterError(ConnectionState.Unavailable, "Antigravity reported no usable quota windows.");
    const ordered = [...pools.values()].sort((left, right) =>
    {
        return poolRank(left.id) - poolRank(right.id) || left.id.localeCompare(right.id);
    });
    for (const pool of ordered)
        pool.windows.sort(compareWindows);
    return { observedAt, pools: ordered, metadata: [] };
}

function assertNoTokensConsumed(usage: unknown): void
{
    const record = asRecord(usage);
    if (record === undefined)
        return;
    for (const key of TOKEN_COUNTER_KEYS)
    {
        const value = asNumber(record[key]);
        if (value === undefined || value <= 0)
            continue;
        const message = "The Antigravity usage probe consumed model tokens; automatic polling is stopped.";
        throw new AdapterError(ConnectionState.Unsupported, message);
    }
}

function windowLabel(windowText: string | undefined, fallback: string): string
{
    if (windowText === undefined)
        return fallback;
    const normalized = windowText.trim().toLowerCase();
    if (normalized === "weekly")
        return "Weekly";
    if (normalized === "daily")
        return "Daily";
    if (normalized === "monthly")
        return "Monthly";
    return windowText.trim();
}

function parseWindowMinutes(windowText: string | undefined): number | undefined
{
    if (windowText === undefined)
        return undefined;
    const normalized = windowText.trim().toLowerCase();
    if (normalized === "weekly")
        return 10080;
    if (normalized === "daily")
        return 1440;
    if (normalized === "monthly")
        return 43200;
    const match = /^(\d+)\s*([hmd])$/.exec(normalized);
    if (match === null)
        return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0)
        return undefined;
    if (match[2] === "h")
        return amount * 60;
    if (match[2] === "d")
        return amount * 1440;
    return amount;
}

function parseResetTime(value: unknown): number | undefined
{
    const text = asString(value);
    if (text === undefined)
        return undefined;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function bucketPoolId(bucketId: string): string | undefined
{
    if (/^gemini[-_]/i.test(bucketId))
        return "gemini";
    if (/^3p[-_]/i.test(bucketId))
        return "other";
    return undefined;
}

function groupPoolId(groupName: string): string | undefined
{
    if (/gemini/i.test(groupName))
        return "gemini";
    if (/claude|gpt|other/i.test(groupName))
        return "other";
    return undefined;
}

function slug(text: string): string
{
    const normalized = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized.length === 0 ? "unknown" : normalized;
}

function poolRank(id: string): number
{
    if (id === "gemini")
        return 0;
    if (id === "other")
        return 1;
    return 2;
}
