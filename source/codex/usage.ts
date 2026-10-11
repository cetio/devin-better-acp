import { UsageError, UsageReport, UsageWindow, UsagePool, MetadataEntry, ConnectionState } from "../usage";
import { asNumber, asRecord, asString } from "../parse";

export function parseRateLimits(result: unknown): UsageReport
{
    const record = asRecord(result);
    if (record === undefined)
        throw new UsageError(ConnectionState.Unsupported, "Codex returned an unexpected rate-limit response.");
    const pools: UsagePool[] = [];
    const byId = asRecord(record.rateLimitsByLimitId);
    if (byId !== undefined && Object.keys(byId).length > 0)
    {
        for (const [poolKey, poolValue] of Object.entries(byId))
        {
            const pool = parsePool(poolKey, poolValue);
            if (pool !== undefined)
                pools.push(pool);
        }
    }
    else
    {
        const pool = parsePool("codex", record.rateLimits);
        if (pool !== undefined)
            pools.push(pool);
    }
    if (pools.length === 0)
        throw new UsageError(ConnectionState.Unsupported, "Codex reported no usable rate-limit windows.");
    pools.sort((left, right) => left.id.localeCompare(right.id));
    return { pools, metadata: parseMetadata(record), partial: false };
}

function parsePool(poolKey: string, poolValue: unknown): UsagePool | undefined
{
    const entry = asRecord(poolValue);
    if (entry === undefined)
        return undefined;
    const poolId = asString(entry.limitId) ?? poolKey;
    const windows: UsageWindow[] = [];
    const primary = parseWindow(poolId, "primary", entry.primary);
    if (primary !== undefined)
        windows.push(primary);
    const secondary = parseWindow(poolId, "secondary", entry.secondary);
    if (secondary !== undefined)
        windows.push(secondary);
    if (windows.length === 0)
        return undefined;
    windows.sort(compareWindows);
    return { id: poolId, label: poolLabel(poolId, asString(entry.limitName)), windows };
}

function parseWindow(poolId: string, position: string, value: unknown): UsageWindow | undefined
{
    const record = asRecord(value);
    if (record === undefined)
        return undefined;
    const usedPercent = asNumber(record.usedPercent);
    if (usedPercent === undefined || usedPercent < 0)
        return undefined;
    const duration = asNumber(record.windowDurationMins);
    const durationMinutes = duration !== undefined && duration > 0 ? duration : undefined;
    const resetsAt = asNumber(record.resetsAt);
    const label = durationMinutes === undefined
        ? position
        : durationMinutes === 10080 ? "Weekly"
            : durationMinutes === 1440 ? "Daily"
                : durationMinutes % 1440 === 0 ? `${durationMinutes / 1440}d`
                    : durationMinutes % 60 === 0 ? `${durationMinutes / 60}h`
                        : `${durationMinutes}m`;
    return {
        id: `${poolId}:${position}`,
        label,
        usedPercent,
        durationMinutes,
        resetsAt: resetsAt !== undefined && resetsAt > 0 ? resetsAt * 1000 : undefined,
    };
}

function compareWindows(left: UsageWindow, right: UsageWindow): number
{
    const leftDuration = left.durationMinutes ?? Number.POSITIVE_INFINITY;
    const rightDuration = right.durationMinutes ?? Number.POSITIVE_INFINITY;
    return leftDuration - rightDuration || left.id.localeCompare(right.id);
}

function parseMetadata(record: Record<string, unknown>): MetadataEntry[]
{
    const entry = defaultLimitRecord(record);
    if (entry === undefined)
        return [];
    const metadata: MetadataEntry[] = [];
    const plan = asString(entry.planType);
    if (plan !== undefined)
        metadata.push({ label: "Plan", value: capitalize(plan) });
    const credits = asRecord(entry.credits);
    if (credits !== undefined)
    {
        if (credits.unlimited === true)
            metadata.push({ label: "Extra credits", value: "Unlimited" });
        else if (credits.hasCredits === true)
            metadata.push({ label: "Extra credits", value: asString(credits.balance) ?? "Available" });
        else
            metadata.push({ label: "Extra credits", value: "None" });
    }
    const reached = asString(entry.rateLimitReachedType);
    if (reached !== undefined)
        metadata.push({ label: "Limit reached", value: capitalize(reached) });
    if (entry.spendControlReached === true)
        metadata.push({ label: "Spend control", value: "Reached" });
    const resets = asRecord(record.rateLimitResetCredits);
    const availableCount = resets === undefined ? undefined : asNumber(resets.availableCount);
    if (availableCount !== undefined && availableCount >= 0)
        metadata.push({ label: "Rate-limit resets available", value: String(availableCount) });
    return metadata;
}

function defaultLimitRecord(record: Record<string, unknown>): Record<string, unknown> | undefined
{
    const direct = asRecord(record.rateLimits);
    if (direct !== undefined)
        return direct;
    const byId = asRecord(record.rateLimitsByLimitId);
    return byId === undefined ? undefined : asRecord(byId.codex);
}

function poolLabel(poolId: string, limitName: string | undefined): string
{
    if (limitName !== undefined)
        return limitName;
    if (poolId === "codex")
        return "Codex";
    return capitalize(poolId.replace(/[_-]+/g, " "));
}

function capitalize(text: string): string
{
    if (text.length === 0)
        return text;
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
