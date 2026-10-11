import { readAntigravityConfig } from "./antigravity/config";
import type { AntigravityConfig } from "./antigravity/config";
import { readCodexConfig } from "./codex/config";
import type { CodexConfig } from "./codex/config";
import type { ProviderId } from "./usage";
import type { ProviderCLI } from "./cli";

import type * as vscode from "vscode";

export type ProviderConfig = {
    id: ProviderId;
    label: string;
    enabled: boolean;
    path: string;
    visible: boolean;
    cli: ProviderCLI;
};

export type ExtensionConfig = {
    providers: Array<CodexConfig | AntigravityConfig>;
    intervalMs: number;
    staleAfterMs: number;
    alignment: "left" | "right";
};

export type ConfigurationReader = Pick<vscode.WorkspaceConfiguration, "get" | "inspect">;

export const DEFAULT_INTERVAL_SECONDS = 180;
export const MAX_INTERVAL_MS = 2 ** 31 - 1;

export function readExtensionConfig(configuration: ConfigurationReader): ExtensionConfig
{
    const intervalMs = intervalMilliseconds(configuration.get("refreshIntervalSeconds"));
    return {
        providers: [readCodexConfig(configuration), readAntigravityConfig(configuration)],
        intervalMs,
        staleAfterMs: intervalMs === 0 ? Number.POSITIVE_INFINITY : intervalMs * 2,
        alignment: configuration.get("statusBar.alignment") === "left" ? "left" : "right",
    };
}

export function intervalMilliseconds(value: unknown): number
{
    if (typeof value !== "number" || !Number.isFinite(value))
        return DEFAULT_INTERVAL_SECONDS * 1000;
    if (value <= 0)
        return 0;
    return Math.max(1, Math.min(Math.round(value * 1000), MAX_INTERVAL_MS));
}
