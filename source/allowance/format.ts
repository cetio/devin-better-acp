import type { UsagePool, UsageWindow } from "./model";

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

export function remainingPercent(usedPercent: number): number
{
    return Math.max(0, 100 - usedPercent);
}

export function compareWindows(left: UsageWindow, right: UsageWindow): number
{
    const leftDuration = left.durationMinutes ?? Number.POSITIVE_INFINITY;
    const rightDuration = right.durationMinutes ?? Number.POSITIVE_INFINITY;
    if (leftDuration !== rightDuration)
        return leftDuration - rightDuration;
    return left.id.localeCompare(right.id);
}

export function bindingWindow(pool: UsagePool): UsageWindow | undefined
{
    let ret: UsageWindow | undefined;
    for (const window of pool.windows)
    {
        if (ret === undefined || isBinding(window, ret))
            ret = window;
    }
    return ret;
}

function isBinding(candidate: UsageWindow, current: UsageWindow): boolean
{
    if (candidate.usedPercent !== current.usedPercent)
        return candidate.usedPercent > current.usedPercent;
    const candidateDuration = candidate.durationMinutes ?? Number.POSITIVE_INFINITY;
    const currentDuration = current.durationMinutes ?? Number.POSITIVE_INFINITY;
    if (candidateDuration !== currentDuration)
        return candidateDuration < currentDuration;
    return candidate.id < current.id;
}

export function durationAbbreviation(minutes: number): string
{
    if (minutes === 10080)
        return "W";
    if (minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}

export function durationLabel(minutes: number): string
{
    if (minutes === 10080)
        return "Weekly";
    if (minutes === 1440)
        return "Daily";
    return durationAbbreviation(minutes);
}

export function windowAbbreviation(window: UsageWindow): string
{
    if (window.durationMinutes !== undefined && window.durationMinutes > 0)
        return durationAbbreviation(window.durationMinutes);
    return labelAbbreviation(window.label);
}

function labelAbbreviation(label: string): string
{
    const normalized = label.trim().toLowerCase();
    if (normalized === "weekly")
        return "W";
    if (normalized === "daily")
        return "D";
    if (normalized === "monthly")
        return "M";
    const numeric = /^(\d+)\s*([hmd])$/.exec(normalized);
    if (numeric !== null)
        return `${numeric[1]}${numeric[2]}`;
    const stripped = sanitizeLabel(label).replace(/\s+/g, "");
    if (stripped.length === 0)
        return "?";
    return stripped.length <= 3 ? stripped : stripped.slice(0, 3);
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
