import { codexCLI } from "./cli";
import type { ConfigurationReader, ProviderConfig } from "../config";

export type CodexConfig = ProviderConfig & { id: "codex" };

export function readCodexConfig(configuration: ConfigurationReader): CodexConfig
{
    return {
        id: "codex",
        label: "Codex",
        enabled: booleanSetting(configuration.get("codex.enabled"), true),
        path: pathSetting(configuration.get("codex.path")),
        visible: booleanSetting(configuration.get("statusBar.showCodex"), true),
        cli: codexCLI,
    };
}

function booleanSetting(value: unknown, fallback: boolean): boolean
{
    return typeof value === "boolean" ? value : fallback;
}

function pathSetting(value: unknown): string
{
    return typeof value === "string" ? value.trim() : "";
}
