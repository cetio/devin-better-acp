export function asRecord(value: unknown): Record<string, unknown> | undefined
{
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined
{
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

export function asNumber(value: unknown): number | undefined
{
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseDurationMinutes(value: string | undefined): number | undefined
{
    if (value === undefined)
        return undefined;
    const normalized = value.trim().toLowerCase();
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
