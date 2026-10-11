import { antigravityCLI } from "./cli";
import type { ConfigurationReader, ProviderConfig } from "../config";

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AntigravityConfig = ProviderConfig & {
    id: "antigravity";
    spoofZed: boolean;
    devinMcp: boolean;
    systemPrompt: boolean;
};

export type AntigravityLaunchSettings = {
    spoofZed: boolean;
    devinMcp: boolean;
    systemPrompt: boolean;
};

export const DEFAULT_LAUNCH_SETTINGS: AntigravityLaunchSettings = {
    spoofZed: true,
    devinMcp: true,
    systemPrompt: true,
};

export function readAntigravityConfig(configuration: ConfigurationReader): AntigravityConfig
{
    const visible = configuration.inspect<boolean>("statusBar.showAntigravity")?.globalValue
        ?? ((configuration.inspect<boolean>("statusBar.showGemini")?.globalValue ?? true)
            || (configuration.inspect<boolean>("statusBar.showOther")?.globalValue ?? true));
    return {
        id: "antigravity",
        label: "Antigravity",
        enabled: booleanSetting(configuration.get("antigravity.enabled"), true),
        path: pathSetting(configuration.get("antigravity.path")),
        visible,
        cli: antigravityCLI,
        spoofZed: booleanSetting(configuration.get("antigravity.spoofZed"), true),
        devinMcp: booleanSetting(configuration.get("antigravity.devinMcp"), true),
        systemPrompt: booleanSetting(configuration.get("antigravity.systemPrompt"), true),
    };
}

export function antigravityLaunchSettings(config: AntigravityConfig): AntigravityLaunchSettings
{
    return { spoofZed: config.spoofZed, devinMcp: config.devinMcp, systemPrompt: config.systemPrompt };
}

export function antigravityLaunchConfigPath(homeDirectory: string = homedir()): string
{
    return join(homeDirectory, ".config", "devin", "devin-better-antigravity.json");
}

export async function writeAntigravityLaunchSettings(
    settings: AntigravityLaunchSettings,
    configPath: string = antigravityLaunchConfigPath(),
): Promise<void>
{
    const text = `${JSON.stringify(settings, null, 2)}\n`;
    try
    {
        await mkdir(dirname(configPath), { recursive: true });
        try
        {
            const [current, attributes] = await Promise.all([readFile(configPath, "utf8"), stat(configPath)]);
            if (current === text && (attributes.mode & 0o777) === 0o600)
                return;
        }
        catch (error)
        {
            if (!isMissingFile(error))
                throw error;
        }

        const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
        const file = await open(temporaryPath, "wx", 0o600);
        let committed = false;
        try
        {
            await file.writeFile(text, "utf8");
            await file.chmod(0o600);
            await file.sync();
            await file.close();
            await rename(temporaryPath, configPath);
            committed = true;
        }
        finally
        {
            await file.close().catch(() => undefined);
            if (!committed)
                await unlink(temporaryPath).catch(() => undefined);
        }
    }
    catch
    {
        throw new Error("Could not save Antigravity launch settings.");
    }
}

function booleanSetting(value: unknown, fallback: boolean): boolean
{
    return typeof value === "boolean" ? value : fallback;
}

function pathSetting(value: unknown): string
{
    return typeof value === "string" ? value.trim() : "";
}

function isMissingFile(error: unknown): boolean
{
    return typeof error === "object" && error !== null && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT";
}
