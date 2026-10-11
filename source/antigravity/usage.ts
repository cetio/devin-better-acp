import { UsageError, UsagePool, UsageReport, UsageWindow, ConnectionState } from "../usage";
import { asNumber, asRecord, asString, parseDurationMinutes } from "../parse";

const TOKEN_COUNTER_KEYS = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
const SIGN_IN_MESSAGE = "Antigravity CLI is not signed in. Run `agy`, sign in, then retry.";
const TOKEN_STOP_MESSAGE = "The Antigravity usage probe consumed model tokens; automatic polling is stopped.";
const EXPECTED_POOL_IDS = ["gemini", "other"];

export function parseUsageReport(payload: unknown): UsageReport
{
    const root = asRecord(payload);
    if (root === undefined)
        throw new UsageError(ConnectionState.Unsupported, "Antigravity CLI returned an unreadable usage report.");
    assertNoTokensConsumed(root.usage);
    const status = asString(root.status);
    if (status !== undefined && status !== "SUCCESS")
    {
        const error = asString(root.error);
        if (error !== undefined && /auth|login|credential|signed in/i.test(error))
            throw new UsageError(ConnectionState.AuthRequired, SIGN_IN_MESSAGE);
        throw new UsageError(ConnectionState.Unavailable, "Antigravity usage command failed.");
    }
    const command = asRecord(root.command);
    if (asString(command?.name) !== "usage")
        throw new UsageError(ConnectionState.Unsupported, "Antigravity CLI did not answer the usage command. Update the CLI, then retry.");
    const data = asRecord(command?.data) ?? asRecord(root.data);
    const groups = data === undefined || !Array.isArray(data.groups) ? [] : data.groups;
    if (groups.length === 0)
        throw new UsageError(ConnectionState.Unavailable, "Antigravity reported no quota groups.");

    const pools = new Map<string, UsagePool>();
    for (const groupValue of groups)
    {
        const group = asRecord(groupValue);
        if (group === undefined)
            continue;
        const groupName = asString(group.name) ?? "Antigravity";
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
            const resetText = asString(bucket.reset_time);
            const resetAt = resetText === undefined ? undefined : Date.parse(resetText);
            const window: UsageWindow = {
                id: bucketId,
                label: windowLabel(windowText, bucketId),
                usedPercent: (1 - Math.min(Math.max(remaining, 0), 1)) * 100,
                durationMinutes: parseDurationMinutes(windowText),
                resetsAt: resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined,
            };
            const knownPoolId = bucketPoolId(bucketId) ?? groupPoolId(groupName);
            const fallbackId = groupName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
            const poolId = knownPoolId ?? (fallbackId.length === 0 ? "unknown" : fallbackId);
            const pool = pools.get(poolId);
            if (pool === undefined)
            {
                pools.set(poolId, { id: poolId, label: groupName, windows: [window] });
            }
            else
                pool.windows.push(window);
        }
    }
    if (pools.size === 0)
        throw new UsageError(ConnectionState.Unavailable, "Antigravity reported no usable quota windows.");
    const ordered = [...pools.values()].sort((left, right) =>
        poolRank(left.id) - poolRank(right.id) || left.id.localeCompare(right.id));
    for (const pool of ordered)
        pool.windows.sort(compareWindows);
    const partial = EXPECTED_POOL_IDS.some((poolId) => !pools.has(poolId));
    return { pools: ordered, metadata: [], partial };
}

function assertNoTokensConsumed(usage: unknown): void
{
    const record = asRecord(usage);
    if (record === undefined)
        return;
    for (const key of TOKEN_COUNTER_KEYS)
    {
        const value = asNumber(record[key]);
        if (value !== undefined && value > 0)
            throw new UsageError(ConnectionState.Unsupported, TOKEN_STOP_MESSAGE, true);
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

function compareWindows(left: UsageWindow, right: UsageWindow): number
{
    const leftDuration = left.durationMinutes ?? Number.POSITIVE_INFINITY;
    const rightDuration = right.durationMinutes ?? Number.POSITIVE_INFINITY;
    return leftDuration - rightDuration || left.id.localeCompare(right.id);
}

function poolRank(poolId: string): number
{
    if (poolId === "gemini")
        return 0;
    if (poolId === "other")
        return 1;
    return 2;
}
