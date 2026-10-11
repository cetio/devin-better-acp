import {
    bindingWindow,
    escapeMarkdown,
    formatAge,
    formatPercent,
    sanitizeLabel,
} from "../allowance/format";
import { snapshotIsStale } from "../allowance/schedule";
import {
    ConnectionState,
    ProviderId,
    ProviderStatus,
    UsagePool,
    UsageWindow,
} from "../allowance/model";
import { UsageState } from "../usage";

import * as vscode from "vscode";

const DISPLAY_PROVIDERS: Array<{ provider: ProviderId; label: string; id: string; priority: number }> = [
    { provider: "codex", label: "Codex", id: "devinBetterACP.codex", priority: 3 },
    { provider: "antigravity", label: "Antigravity", id: "devinBetterACP.antigravity", priority: 2 },
];
const WARNING_PERCENT = 90;
const ERROR_PERCENT = 100;

export type DisplayContext = Pick<UsageState, "now" | "staleAfterMs">;

export type StatusTone = "normal" | "warning" | "error";

export type StatusDisplay = {
    visible: boolean;
    text: string;
    tone: StatusTone;
    accessibility: string;
    tooltip: string;
};

type PoolWindow = {
    pool: UsagePool;
    window: UsageWindow;
};

export function statusDisplay(
    status: ProviderStatus | undefined,
    provider: ProviderId,
    context: DisplayContext,
): StatusDisplay
{
    const label = status?.label ?? providerLabel(provider);
    if (status === undefined)
    {
        return {
            visible: true,
            text: label,
            tone: "normal",
            accessibility: `${label} usage is starting.`,
            tooltip: `**${escapeMarkdown(label)} usage**\n\nWaiting for the first refresh.`,
        };
    }
    if (status.state === ConnectionState.Disabled)
        return { visible: false, text: "", tone: "normal", accessibility: "", tooltip: "" };
    const pools = (status.snapshot?.pools ?? []).filter((pool) => pool.windows.length > 0);
    const poolWindows: PoolWindow[] = [];
    for (const pool of pools)
    {
        const window = bindingWindow(pool);
        if (window !== undefined)
            poolWindows.push({ pool, window });
    }
    if (poolWindows.length === 0)
    {
        const loading = status.snapshot === undefined && status.refreshing;
        return {
            visible: true,
            text: label,
            tone: "normal",
            accessibility: `${label} usage is ${loading ? "loading" : "unavailable"}.`,
            tooltip: emptyTooltip(status, context),
        };
    }
    const stale = snapshotIsStale(status, context.now, context.staleAfterMs);
    const mostUsed = poolWindows.reduce((left, right) =>
        left.window.usedPercent >= right.window.usedPercent ? left : right);
    return {
        visible: true,
        text: label,
        tone: toneFor(mostUsed.window.usedPercent),
        accessibility: accessibility(label, poolWindows, stale),
        tooltip: tooltip(status, pools, context),
    };
}

export function describeState(status: ProviderStatus, context: DisplayContext): string
{
    const age = status.lastSuccessAt === undefined ? undefined : formatAge(context.now - status.lastSuccessAt);
    switch (status.state)
    {
        case ConnectionState.Ready:
            return age === undefined ? "ready" : `updated ${age}`;
        case ConnectionState.Partial:
            return age === undefined ? "partially ready" : `partially updated ${age}`;
        case ConnectionState.Stale:
            return age === undefined ? "stale" : `stale, updated ${age}`;
        case ConnectionState.Loading:
            return "loading";
        case ConnectionState.MissingCli:
            return "CLI not found";
        case ConnectionState.AuthRequired:
            return "sign-in required";
        case ConnectionState.Unsupported:
            return "unsupported";
        case ConnectionState.Disabled:
            return "disabled";
        default:
            return "unavailable";
    }
}

export class StatusBarView
{
    private readonly items = new Map<ProviderId, vscode.StatusBarItem>();
    private alignment: "left" | "right";
    private visibility: Record<ProviderId, boolean>;

    constructor(alignment: "left" | "right", visibility: Record<ProviderId, boolean>)
    {
        this.alignment = alignment;
        this.visibility = visibility;
        this.create();
    }

    update(state: UsageState): void
    {
        for (const displayProvider of DISPLAY_PROVIDERS)
        {
            const item = this.items.get(displayProvider.provider);
            if (item === undefined)
                continue;
            const status = state.statuses.find((candidate) => candidate.provider === displayProvider.provider);
            const display = statusDisplay(status, displayProvider.provider, state);
            if (!display.visible || !this.visibility[displayProvider.provider])
            {
                item.hide();
                continue;
            }
            item.text = display.text;
            item.tooltip = new vscode.MarkdownString(display.tooltip);
            item.backgroundColor = display.tone === "warning"
                ? new vscode.ThemeColor("statusBarItem.warningBackground")
                : display.tone === "error"
                    ? new vscode.ThemeColor("statusBarItem.errorBackground")
                    : undefined;
            item.accessibilityInformation = { label: display.accessibility };
            item.show();
        }
    }

    setAlignment(alignment: "left" | "right"): void
    {
        if (this.alignment === alignment)
            return;
        this.alignment = alignment;
        this.dispose();
        this.create();
    }

    setVisibility(visibility: Record<ProviderId, boolean>): void
    {
        this.visibility = visibility;
    }

    dispose(): void
    {
        for (const item of this.items.values())
            item.dispose();
        this.items.clear();
    }

    private create(): void
    {
        for (const displayProvider of DISPLAY_PROVIDERS)
        {
            const item = vscode.window.createStatusBarItem(
                displayProvider.id,
                this.alignment === "right" ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
                displayProvider.priority,
            );
            item.name = `${displayProvider.label} Usage`;
            item.command = {
                title: "Show Usage",
                command: "devinBetterACP.showUsage",
                arguments: [{ provider: displayProvider.provider }],
            };
            this.items.set(displayProvider.provider, item);
        }
    }
}

function providerLabel(provider: ProviderId): string
{
    return provider === "codex" ? "Codex" : "Antigravity";
}

function tooltip(status: ProviderStatus, pools: UsagePool[], context: DisplayContext): string
{
    const blocks = pools.map((pool) =>
    {
        const summary = summaryLine(pool);
        return status.provider === "antigravity"
            ? `**${escapeMarkdown(sanitizeLabel(pool.label))}**\n${summary}`
            : summary;
    });
    if (snapshotIsStale(status, context.now, context.staleAfterMs))
    {
        const age = status.lastSuccessAt === undefined ? undefined : formatAge(context.now - status.lastSuccessAt);
        blocks.push(age === undefined ? "_Last known values._" : `_Last known values — updated ${age}._`);
    }
    if (status.message !== undefined)
        blocks.push(escapeMarkdown(sanitizeLabel(status.message)));
    return blocks.join("\n\n");
}

function emptyTooltip(status: ProviderStatus, context: DisplayContext): string
{
    const blocks = [`**${escapeMarkdown(status.label)} usage**`, `_${capitalize(describeState(status, context))}._`];
    if (status.message !== undefined)
        blocks.push(escapeMarkdown(sanitizeLabel(status.message)));
    return blocks.join("\n\n");
}

function summaryLine(pool: UsagePool): string
{
    const parts = pool.windows.map((window) =>
    {
        const label = escapeMarkdown(sanitizeLabel(window.label));
        return `${label}: ${formatPercent(window.usedPercent)} quota used`;
    });
    return parts.join(" · ");
}

function accessibility(label: string, poolWindows: PoolWindow[], stale: boolean): string
{
    const details = poolWindows.map(({ pool, window }) =>
    {
        const poolLabel = sanitizeLabel(pool.label);
        const windowLabel = sanitizeLabel(window.label);
        return poolWindows.length === 1
            ? `${formatPercent(window.usedPercent)} used in the ${windowLabel} window.`
            : `${poolLabel}: ${formatPercent(window.usedPercent)} used in the ${windowLabel} window.`;
    });
    const parts = [`${label} usage: ${details.join(" ")}`];
    if (stale)
        parts.push("Values are stale.");
    parts.push("Press Enter for details and actions.");
    return parts.join(" ");
}

function toneFor(usedPercent: number): StatusTone
{
    if (usedPercent >= ERROR_PERCENT)
        return "error";
    return usedPercent >= WARNING_PERCENT ? "warning" : "normal";
}

function capitalize(text: string): string
{
    if (text.length === 0)
        return text;
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}
