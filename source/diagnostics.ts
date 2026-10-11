import { formatAge, formatTimestamp } from "./allowance/format";
import { ProviderStatus } from "./allowance/model";
import { RefreshInfo, UsageState } from "./usage";
import { describeState } from "./ui/status";

import * as vscode from "vscode";

const MAX_EVENTS = 50;

export class Diagnostics
{
    private readonly channel = vscode.window.createOutputChannel("Devin Better ACP");
    private readonly events: string[] = [];

    note(info: RefreshInfo): void
    {
        const parts = [`${formatTimestamp(Date.now())} ${info.provider} refresh: ${info.state} (${info.durationMs}ms)`];
        if (info.cliVersion !== undefined)
            parts.push(`cli ${info.cliVersion}`);
        if (info.message !== undefined)
            parts.push(info.message);
        this.events.push(parts.join(" \u00b7 "));
        if (this.events.length > MAX_EVENTS)
            this.events.shift();
    }

    show(state: UsageState): void
    {
        this.channel.clear();
        this.channel.appendLine(`Devin Better ACP diagnostics \u2014 ${formatTimestamp(state.now)}`);
        for (const status of state.statuses)
        {
            this.channel.appendLine("");
            this.channel.appendLine(`${status.label}: ${status.state} (${describeState(status, state)})`);
            this.channel.appendLine(`  CLI: ${status.cliVersion ?? "unknown"}`);
            this.channel.appendLine(`  Last attempt: ${attemptText(status)}`);
            this.channel.appendLine(`  Last success: ${successText(status, state)}`);
            if (status.message !== undefined)
                this.channel.appendLine(`  Message: ${status.message}`);
            for (const pool of status.snapshot?.pools ?? [])
            {
                const windows = pool.windows.map((window) => `${window.label}=${window.usedPercent.toFixed(2)}%`);
                this.channel.appendLine(`  Pool ${pool.id}: ${windows.join(", ")}`);
            }
        }
        if (this.events.length > 0)
        {
            this.channel.appendLine("");
            this.channel.appendLine("Recent refresh events:");
            for (const event of this.events)
                this.channel.appendLine(`  ${event}`);
        }
        this.channel.show();
    }

    dispose(): void
    {
        this.channel.dispose();
    }
}

function attemptText(status: ProviderStatus): string
{
    return status.lastAttemptAt === undefined ? "never" : formatTimestamp(status.lastAttemptAt);
}

function successText(status: ProviderStatus, state: UsageState): string
{
    if (status.lastSuccessAt === undefined)
        return "never";
    const age = formatAge(state.now - status.lastSuccessAt);
    return `${formatTimestamp(status.lastSuccessAt)} (${age})`;
}
