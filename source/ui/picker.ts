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
import { UsageState } from "../usage";
import { describeState, DisplayContext } from "./status";

import * as vscode from "vscode";

export type PickerFocus = {
    provider: ProviderId;
    poolId?: string;
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

export type PickerCallbacks = {
    refreshAll: () => Promise<void>;
    refreshProvider: (provider: ProviderId) => Promise<void>;
    retry: (provider: ProviderId) => Promise<void>;
    configureCli: (provider: ProviderId) => void;
    openSettings: () => void;
    showDiagnostics: () => void;
    openChatGptUsage: () => void;
    setEnabled: (provider: ProviderId, enabled: boolean) => void;
};

type UsagePickItem = vscode.QuickPickItem & { id: string; action?: PickAction };

type PickerPage = "usage" | "management";

export function pickerTitle(statuses: ProviderStatus[], focus?: PickerFocus): string
{
    if (focus === undefined)
        return "Devin Better ACP";
    const status = statuses.find((candidate) => candidate.provider === focus.provider);
    if (focus.poolId === undefined)
        return `Devin Better ACP · ${status?.label ?? providerLabel(focus.provider)}`;
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
            pool.windows.length > 0 && (focus?.poolId === undefined || pool.id === focus.poolId));
        if (pools.length === 0 || status.state === ConnectionState.Disabled)
        {
            items.push(separator(`provider.${status.provider}`, focus === undefined ? status.label : "Allowance"));
            items.push(pick({
                id: `status.${status.provider}`,
                label: status.state === ConnectionState.Disabled
                    ? "Monitoring disabled"
                    : status.refreshing ? "Refreshing usage…" : "Usage unavailable",
                description: describeState(status, context),
                detail: status.message ?? (
                    focus?.poolId === undefined ? undefined : "No usage reported for this pool."
                ),
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
                focus?.poolId === undefined ? poolHeading(status.provider, pool.id, pools) : "Allowance",
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
            focus?.poolId === undefined ? `${status.label} · Details` : "Details",
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

export class UsagePicker
{
    private readonly callbacks: PickerCallbacks;
    private readonly refreshButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon("refresh"),
        tooltip: "Refresh usage",
    };
    private picker: vscode.QuickPick<UsagePickItem> | undefined;
    private focus: PickerFocus | undefined;
    private page: PickerPage = "usage";
    private refreshing = false;
    private state: UsageState = {
        statuses: [],
        now: Date.now(),
        staleAfterMs: Number.POSITIVE_INFINITY,
    };

    constructor(callbacks: PickerCallbacks)
    {
        this.callbacks = callbacks;
    }

    show(state: UsageState, focus?: PickerFocus): void
    {
        this.state = state;
        this.focus = focus;
        this.page = "usage";
        const picker = this.ensurePicker();
        picker.value = "";
        this.render();
        picker.show();
        void this.refresh(focus?.provider);
    }

    update(state: UsageState): void
    {
        this.state = state;
        this.render();
    }

    dispose(): void
    {
        const picker = this.picker;
        this.picker = undefined;
        picker?.dispose();
    }

    private ensurePicker(): vscode.QuickPick<UsagePickItem>
    {
        if (this.picker !== undefined)
            return this.picker;
        const picker = vscode.window.createQuickPick<UsagePickItem>();
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        picker.onDidTriggerButton((button) =>
        {
            if (button === vscode.QuickInputButtons.Back)
                this.back();
            else
                void this.refresh();
        });
        picker.onDidAccept(() => this.accept(picker));
        picker.onDidHide(() =>
        {
            if (this.picker === picker)
                this.picker = undefined;
            picker.dispose();
        });
        this.picker = picker;
        return picker;
    }

    private render(): void
    {
        const picker = this.picker;
        if (picker === undefined)
            return;
        const statuses = this.state.statuses;
        const context = this.state;
        const management = this.page === "management";
        const title = management
            ? `${pickerTitle(statuses, this.focus)} · Settings & connection`
            : pickerTitle(statuses, this.focus);
        const placeholder = management
            ? "Choose a connection or settings action"
            : "Filter limits and details";
        const items = management
            ? managementItems(statuses, this.focus)
            : pickerItems(statuses, context, this.focus);
        const activeId = picker.activeItems[0]?.id;
        const mapped = mapItems(items);
        picker.title = title;
        picker.placeholder = placeholder;
        picker.items = mapped;
        const active = mapped.find((item) => item.id === activeId) ?? mapped.find((item) => item.action !== undefined);
        picker.activeItems = active === undefined ? [] : [active];
        const provider = this.focus?.provider;
        picker.busy = this.refreshing || statuses.some((status) =>
        {
            return (provider === undefined || status.provider === provider) && status.refreshing;
        });
        const refresh = {
            ...this.refreshButton,
            tooltip: provider === undefined ? "Refresh all usage" : `Refresh ${provider} usage`,
        };
        picker.buttons = this.page === "usage" && this.focus === undefined
            ? [refresh]
            : [vscode.QuickInputButtons.Back, refresh];
    }

    private back(): void
    {
        if (this.page === "usage")
            this.focus = undefined;
        this.page = "usage";
        if (this.picker !== undefined)
            this.picker.value = "";
        this.render();
    }

    private async refresh(provider = this.focus?.provider, reconnect = false): Promise<void>
    {
        if (this.refreshing)
            return;
        this.refreshing = true;
        this.render();
        try
        {
            if (provider === undefined)
                await this.callbacks.refreshAll();
            else if (reconnect)
                await this.callbacks.retry(provider);
            else
                await this.callbacks.refreshProvider(provider);
        }
        catch
        {
            void vscode.window.showErrorMessage(
                "Devin Better ACP: refresh failed. See diagnostics for connection details.",
            );
        }
        finally
        {
            this.refreshing = false;
            this.render();
        }
    }

    private accept(picker: vscode.QuickPick<UsagePickItem>): void
    {
        const action = picker.activeItems[0]?.action;
        if (action === undefined)
            return;
        switch (action.kind)
        {
            case "manage":
                this.page = "management";
                picker.value = "";
                this.render();
                return;
            case "retry":
                void this.refresh(action.provider, true);
                return;
            case "configureCli":
                picker.hide();
                this.callbacks.configureCli(action.provider);
                return;
            case "openSettings":
                picker.hide();
                this.callbacks.openSettings();
                return;
            case "showDiagnostics":
                picker.hide();
                this.callbacks.showDiagnostics();
                return;
            case "openChatGptUsage":
                picker.hide();
                this.callbacks.openChatGptUsage();
                return;
            case "enable":
                this.callbacks.setEnabled(action.provider, true);
                return;
        }
    }
}

function scopedStatuses(statuses: ProviderStatus[], focus: PickerFocus | undefined): ProviderStatus[]
{
    return statuses.filter((status) => focus === undefined || status.provider === focus.provider);
}

function providerLabel(provider: ProviderId): string
{
    return provider === "codex" ? "Codex" : "Antigravity";
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
    return `${providerLabel(provider)} · ${pickerText(label)}`;
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

function mapItems(items: PickItem[]): UsagePickItem[]
{
    return items.map((entry) =>
    {
        const ret: UsagePickItem = {
            id: entry.id,
            label: entry.label,
            kind: entry.kind === "separator" ? vscode.QuickPickItemKind.Separator : vscode.QuickPickItemKind.Default,
        };
        if (entry.description !== undefined)
            ret.description = entry.description;
        if (entry.detail !== undefined)
            ret.detail = entry.detail;
        if (entry.action !== undefined)
            ret.action = entry.action;
        return ret;
    });
}
