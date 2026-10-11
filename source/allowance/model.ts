export type ProviderId = "codex" | "antigravity";

export enum ConnectionState
{
    Loading = "loading",
    Ready = "ready",
    Partial = "partial",
    Stale = "stale",
    MissingCli = "missingCli",
    AuthRequired = "authRequired",
    Unavailable = "unavailable",
    Unsupported = "unsupported",
    Disabled = "disabled",
}

export type UsageWindow = {
    id: string;
    label: string;
    usedPercent: number;
    durationMinutes: number | undefined;
    resetsAt: number | undefined;
};

export type UsagePool = {
    id: string;
    label: string;
    description: string | undefined;
    windows: UsageWindow[];
};

export type MetadataEntry = {
    label: string;
    value: string;
};

export type ProviderSnapshot = {
    observedAt: number;
    pools: UsagePool[];
    metadata: MetadataEntry[];
};

export type ProviderStatus = {
    provider: ProviderId;
    label: string;
    state: ConnectionState;
    message: string | undefined;
    cliVersion: string | undefined;
    snapshot: ProviderSnapshot | undefined;
    refreshing: boolean;
    lastAttemptAt: number | undefined;
    lastSuccessAt: number | undefined;
};

export function expectedPoolIds(provider: ProviderId): string[]
{
    return provider === "codex" ? ["codex"] : ["gemini", "other"];
}
