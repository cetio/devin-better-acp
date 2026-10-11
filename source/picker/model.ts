import {
    compareWindows,
    formatAge,
    formatCountdown,
    formatPercent,
    formatResetMoment,
} from "../allowance/format";
import { snapshotIsStale } from "../allowance/schedule";
import {
    ConnectionState,
    ProviderId,
    ProviderStatus,
    UsagePool,
    UsageWindow,
} from "../allowance/model";
import { describeState, DisplayContext } from "../status/display";

export type PickerFocus = {
    provider: ProviderId;
    poolId: string;
};

export type PickAction =
    | { kind: "manage" }
    | { kind: "retry"; provider: ProviderId }
    | { kind: "configureCli"; provider: ProviderId }
    | { kind: "openSettings" }
    | { kind: "showDiagnostics" }
    | { kind: "openChatGptUsage" }
    | { kind: "enable"; provider: ProviderId };

export type PickItem = {
    id: string;
    kind: "item" | "separator";
    label: string;
    description: string | undefined;
    detail: string | undefined;
    action: PickAction | undefined;
};

type PickSpec = {
    id: string;
    label: string;
    description?: string | undefined;
    detail?: string | undefined;
    action?: PickAction | undefined;
};

export function pickerTitle(statuses: ProviderStatus[], focus?: PickerFocus): string
{
    if (focus === undefined)
        return "Devin Better ACP";
    const status = statuses.find((candidate) => candidate.provider === focus.provider);
    return `Devin Better ACP · ${poolHeading(focus.provider, focus.poolId, status?.snapshot?.pools)}`;
}

export function pickerItems(
    statuses: ProviderStatus[],
    context: DisplayContext,
    focus?: PickerFocus,
): PickItem[]
{
    const items: PickItem[] = [];
    for (const status of scopedStatuses(statuses, focus))
    {
        const pools = (status.snapshot?.pools ?? []).filter((pool) =>
            pool.windows.length > 0 && (focus === undefined || pool.id === focus.poolId));
        if (pools.length === 0 || status.state === ConnectionState.Disabled)
        {
            items.push(separator(`provider.${status.provider}`, focus === undefined ? status.label : "Allowance"));
            items.push(pick({
                id: `status.${status.provider}`,
                label: status.state === ConnectionState.Disabled
                    ? "Monitoring disabled"
                    : status.refreshing ? "Refreshing usage…" : "Usage unavailable",
                description: describeState(status, context),
                detail: status.message ?? (focus === undefined ? undefined : "No usage reported for this pool."),
                action: status.state === ConnectionState.Disabled
                    ? { kind: "enable", provider: status.provider }
                    : { kind: "retry", provider: status.provider },
            }));
            continue;
        }
        for (const pool of pools)
        {
            items.push(separator(
                `pool.${status.provider}.${pool.id}`,
                focus === undefined ? poolHeading(status.provider, pool.id, pools) : "Allowance",
            ));
            const stale = snapshotIsStale(status, context.now, context.staleAfterMs);
            if (stale || status.message !== undefined)
            {
                items.push(pick({
                    id: `status.${status.provider}.${pool.id}`,
                    label: stale ? "$(warning) Last known usage" : "$(info) Connection status",
                    description: updatedText(status, context),
                    detail: status.message,
                }));
            }
            for (const window of [...pool.windows].sort(compareWindows))
            {
                items.push(pick({
                    id: `window.${status.provider}.${pool.id}.${window.id}`,
                    label: `${quotaWindowLabel(window)} · ${formatPercent(window.usedPercent)} used`,
                    detail: resetLine(window, context),
                }));
            }
        }
        items.push(separator(
            `details.${status.provider}`,
            focus === undefined ? `${status.label} · Details` : "Details",
        ));
        for (const entry of status.snapshot?.metadata ?? [])
        {
            items.push(pick({
                id: `metadata.${status.provider}.${entry.label}`,
                label: pickerText(entry.label),
                description: entry.value,
            }));
        }
        items.push(pick({
            id: `updated.${status.provider}`,
            label: "Updated",
            description: updatedText(status, context),
            detail: status.cliVersion === undefined ? status.label : `${status.label} · CLI ${status.cliVersion}`,
        }));
    }
    items.push(separator("actions", "Actions"));
    items.push(pick({
        id: "action.manage",
        label: "$(gear) Settings & connection…",
        detail: "Reconnect, choose a CLI path, or view diagnostics",
        action: { kind: "manage" },
    }));
    return items;
}

export function managementItems(statuses: ProviderStatus[], focus?: PickerFocus): PickItem[]
{
    const items: PickItem[] = [];
    for (const status of scopedStatuses(statuses, focus))
    {
        items.push(separator(`connection.${status.provider}`, status.label));
        items.push(pick({
            id: `action.retry.${status.provider}`,
            label: `$(plug) Reconnect ${status.label}`,
            detail: "Recheck the CLI version and refresh usage",
            action: { kind: "retry", provider: status.provider },
        }));
        items.push(pick({
            id: `action.configure.${status.provider}`,
            label: `$(file) Configure ${status.label} CLI path`,
            action: { kind: "configureCli", provider: status.provider },
        }));
        if (status.provider === "codex")
        {
            items.push(pick({
                id: "action.chatgpt",
                label: "$(link-external) Open ChatGPT usage page",
                action: { kind: "openChatGptUsage" },
            }));
        }
    }
    items.push(separator("settings", "Settings"));
    items.push(pick({ id: "action.settings", label: "$(gear) Open settings", action: { kind: "openSettings" } }));
    items.push(pick({
        id: "action.diagnostics",
        label: "$(output) Show diagnostics",
        action: { kind: "showDiagnostics" },
    }));
    return items;
}

export function quotaWindowLabel(window: UsageWindow): string
{
    if (window.durationMinutes === 10080)
        return "Weekly limit";
    if (window.durationMinutes === 1440)
        return "Daily limit";
    if (window.durationMinutes !== undefined && window.durationMinutes % 60 === 0)
        return `${window.durationMinutes / 60}-hour limit`;
    const label = pickerText(window.label);
    return /limit$/i.test(label) ? label : `${label} limit`;
}

function scopedStatuses(statuses: ProviderStatus[], focus: PickerFocus | undefined): ProviderStatus[]
{
    return statuses.filter((status) => focus === undefined || status.provider === focus.provider);
}

function poolHeading(provider: ProviderId, poolId: string, pools: UsagePool[] | undefined): string
{
    if (provider === "codex" && poolId === "codex")
        return "Codex";
    if (provider === "antigravity" && poolId === "gemini")
        return "Antigravity · Gemini";
    if (provider === "antigravity" && poolId === "other")
        return "Antigravity · Other Models";
    const label = pools?.find((pool) => pool.id === poolId)?.label ?? poolId;
    return `${provider === "codex" ? "Codex" : "Antigravity"} · ${pickerText(label)}`;
}

function resetLine(window: UsageWindow, context: DisplayContext): string
{
    if (window.resetsAt === undefined)
        return "Reset time unknown";
    if (window.resetsAt <= context.now)
        return "Awaiting refresh";
    return `Resets in ${formatCountdown(window.resetsAt - context.now)} · ${formatResetMoment(window.resetsAt)}`;
}

function updatedText(status: ProviderStatus, context: DisplayContext): string
{
    if (status.lastSuccessAt === undefined)
        return "never";
    const age = formatAge(context.now - status.lastSuccessAt);
    return snapshotIsStale(status, context.now, context.staleAfterMs) ? `${age} (stale)` : age;
}

function pickerText(text: string): string
{
    return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/\$\(/g, "$ (");
}

function separator(id: string, label: string): PickItem
{
    return {
        id,
        kind: "separator",
        label: pickerText(label),
        description: undefined,
        detail: undefined,
        action: undefined,
    };
}

function pick(spec: PickSpec): PickItem
{
    return {
        id: spec.id,
        kind: "item",
        label: spec.label,
        description: spec.description === undefined ? undefined : pickerText(spec.description),
        detail: spec.detail === undefined ? undefined : pickerText(spec.detail),
        action: spec.action ?? undefined,
    };
}
