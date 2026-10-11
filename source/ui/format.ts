import { ConnectionState } from "../usage";
import type { ProviderStatus, UsagePool, UsageWindow } from "../usage";

const MAX_LABEL_LENGTH = 48;

export function formatPercent(usedPercent: number): string
{
    if (!Number.isFinite(usedPercent) || usedPercent < 0)
        throw new RangeError("usedPercent must be a finite non-negative number");
    if (usedPercent === 0)
        return "0%";
    if (usedPercent >= 100)
        return `${Math.round(usedPercent)}%`;
    if (usedPercent < 0.05)
        return "<0.1%";
    if (usedPercent > 99.95)
        return ">99.9%";
    return `${(Math.round(usedPercent * 10) / 10).toFixed(1).replace(/\.0$/, "")}%`;
}

export function compareWindows(left: UsageWindow, right: UsageWindow): number
{
    const leftDuration = left.durationMinutes ?? Number.POSITIVE_INFINITY;
    const rightDuration = right.durationMinutes ?? Number.POSITIVE_INFINITY;
    return leftDuration - rightDuration || left.id.localeCompare(right.id);
}

export function bindingWindow(pool: UsagePool): UsageWindow | undefined
{
    let ret: UsageWindow | undefined;
    for (const window of pool.windows)
    {
        if (ret === undefined || window.usedPercent > ret.usedPercent
            || (window.usedPercent === ret.usedPercent && compareWindows(window, ret) < 0))
            ret = window;
    }
    return ret;
}

export function formatCountdown(milliseconds: number): string
{
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
        return "now";
    const totalMinutes = Math.floor(milliseconds / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m`;
    return "<1m";
}

export function formatResetMoment(milliseconds: number): string
{
    const date = new Date(milliseconds);
    const month = date.toLocaleDateString(undefined, { month: "short" });
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return `${month} ${date.getDate()}, ${time}`;
}

export function formatAge(milliseconds: number): string
{
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
        return "unknown";
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 10)
        return "just now";
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

export function sanitizeLabel(text: string): string
{
    const collapsed = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (collapsed.length <= MAX_LABEL_LENGTH)
        return collapsed;
    return `${collapsed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}\u2026`;
}

export function escapeMarkdown(text: string): string
{
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, "\\$&");
}

export function snapshotIsStale(status: ProviderStatus, now: number, staleAfterMs: number): boolean
{
    if (status.snapshot === undefined)
        return false;
    if (status.state !== ConnectionState.Ready && status.state !== ConnectionState.Partial)
        return true;
    if (status.lastSuccessAt === undefined || !Number.isFinite(staleAfterMs))
        return false;
    return now - status.lastSuccessAt > staleAfterMs;
}
