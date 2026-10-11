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
