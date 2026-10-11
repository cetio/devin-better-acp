import { ProviderId } from "./allowance/model";

export type ProviderSettings = {
    enabled: boolean;
    path: string;
};

export type UsageSettings = {
    providers: Record<ProviderId, ProviderSettings>;
    refreshIntervalSeconds: number;
    alignment: "left" | "right";
    visibility: Record<ProviderId, boolean>;
};

export type RawSettings = {
    codexEnabled: unknown;
    codexPath: unknown;
    antigravityEnabled: unknown;
    antigravityPath: unknown;
    refreshIntervalSeconds: unknown;
    alignment: unknown;
    showCodex: unknown;
    showAntigravity: unknown;
};

export const DEFAULT_SETTINGS: UsageSettings = {
    providers: {
        codex: { enabled: true, path: "" },
        antigravity: { enabled: true, path: "" },
    },
    refreshIntervalSeconds: 300,
    alignment: "right",
    visibility: { codex: true, antigravity: true },
};

export function normalizeSettings(raw: RawSettings): UsageSettings
{
    return {
        providers: {
            codex: {
                enabled: asBoolean(raw.codexEnabled, true),
                path: asPath(raw.codexPath),
            },
            antigravity: {
                enabled: asBoolean(raw.antigravityEnabled, true),
                path: asPath(raw.antigravityPath),
            },
        },
        refreshIntervalSeconds: normalizeInterval(raw.refreshIntervalSeconds),
        alignment: raw.alignment === "left" ? "left" : "right",
        visibility: {
            codex: asBoolean(raw.showCodex, true),
            antigravity: asBoolean(raw.showAntigravity, true),
        },
    };
}

export function refreshIntervalMs(settings: UsageSettings): number
{
    return settings.refreshIntervalSeconds <= 0 ? 0 : settings.refreshIntervalSeconds * 1000;
}

export function staleAfterMs(settings: UsageSettings): number
{
    if (settings.refreshIntervalSeconds <= 0)
        return Number.POSITIVE_INFINITY;
    return settings.refreshIntervalSeconds * 2000;
}

function normalizeInterval(value: unknown): number
{
    if (typeof value !== "number" || !Number.isFinite(value))
        return DEFAULT_SETTINGS.refreshIntervalSeconds;
    if (value <= 0)
        return 0;
    return Math.max(value, 60);
}

function asBoolean(value: unknown, fallback: boolean): boolean
{
    return typeof value === "boolean" ? value : fallback;
}

function asPath(value: unknown): string
{
    return typeof value === "string" ? value.trim() : "";
}
