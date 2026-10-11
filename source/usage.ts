import type { PollScheduler } from "./poll";
import type { CliContext } from "./cli";
import type { ExtensionConfig, ProviderConfig } from "./config";

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
    windows: UsageWindow[];
};

export type MetadataEntry = {
    label: string;
    value: string;
};

export type UsageReport = {
    pools: UsagePool[];
    metadata: MetadataEntry[];
    partial: boolean;
};

export type ProviderSnapshot = {
    pools: UsagePool[];
    metadata: MetadataEntry[];
};

export type ProviderStatus = {
    provider: ProviderId;
    label: string;
    state: ConnectionState;
    message: string | undefined;
    snapshot: ProviderSnapshot | undefined;
    refreshing: boolean;
    lastSuccessAt: number | undefined;
};

export type UsageState = {
    now: number;
    staleAfterMs: number;
    statuses: ProviderStatus[];
};

export type UsageServiceOptions = {
    intervalMs: number;
    staleAfterMs: number;
    trusted: boolean;
    now: () => number;
    context: () => CliContext;
    schedule: PollScheduler;
    onDidChange: () => void;
};

export class UsageError extends Error
{
    readonly state: ConnectionState;
    readonly stopPolling: boolean;

    constructor(state: ConnectionState, message: string, stopPolling = false)
    {
        super(message);
        this.name = "UsageError";
        this.state = state;
        this.stopPolling = stopPolling;
    }
}

type RuntimeState = {
    config: ProviderConfig;
    status: ProviderStatus;
    abort: AbortController | undefined;
    inflight: Promise<void> | undefined;
    refreshQueued: boolean;
    stoppedForTokens: boolean;
};

const TIME_TICK_MS = 60000;
const UNTRUSTED_MESSAGE = "Trust this workspace to enable usage monitoring.";
const DISABLED_MESSAGE = "Usage monitoring is disabled in settings.";
const REQUEST_FAILED_MESSAGE = "The usage request failed.";

export class UsageService
{
    private readonly options: UsageServiceOptions;
    private readonly states = new Map<ProviderId, RuntimeState>();
    private intervalMs: number;
    private staleAfterMs: number;
    private trusted: boolean;
    private pollingStop: (() => void) | undefined;
    private displayStop: (() => void) | undefined;
    private disposed = false;

    constructor(options: UsageServiceOptions)
    {
        this.options = options;
        this.intervalMs = options.intervalMs;
        this.staleAfterMs = options.staleAfterMs;
        this.trusted = options.trusted;
        this.displayStop = options.schedule(() => this.emit(), TIME_TICK_MS);
    }

    configure(config: ExtensionConfig): void
    {
        this.updateInterval(config.intervalMs, config.staleAfterMs);
        const refresh = new Set<ProviderId>();
        for (const providerConfig of config.providers)
        {
            const state = this.states.get(providerConfig.id);
            if (state === undefined)
            {
                const created: RuntimeState = {
                    config: providerConfig,
                    status: initialStatus(providerConfig, this.trusted),
                    abort: undefined,
                    inflight: undefined,
                    refreshQueued: false,
                    stoppedForTokens: false,
                };
                this.states.set(providerConfig.id, created);
                if (this.trusted && providerConfig.enabled)
                    refresh.add(providerConfig.id);
                continue;
            }

            const changed = state.config.enabled !== providerConfig.enabled || state.config.path !== providerConfig.path;
            state.config = providerConfig;
            if (!changed)
                continue;
            this.cancel(state, this.trusted && providerConfig.enabled);
            state.status = initialStatus(providerConfig, this.trusted);
            if (state.stoppedForTokens)
            {
                state.status.state = ConnectionState.Unsupported;
                state.status.message = TOKEN_STOP_MESSAGE;
            }
            else if (this.trusted && providerConfig.enabled && state.inflight === undefined)
                refresh.add(providerConfig.id);
        }
        this.syncPolling();
        this.emit();
        for (const provider of refresh)
            void this.refresh(provider);
    }

    getState(): UsageState
    {
        return {
            statuses: this.getStatuses(),
            now: this.options.now(),
            staleAfterMs: this.staleAfterMs,
        };
    }

    getStatuses(): ProviderStatus[]
    {
        return [...this.states.values()].map((state) => state.status);
    }

    refreshAll(): Promise<void>
    {
        return Promise.all([...this.states.keys()].map((provider) => this.refresh(provider))).then(() => undefined);
    }

    refresh(provider: ProviderId): Promise<void>
    {
        return this.refreshProvider(provider, false);
    }

    retry(provider: ProviderId): Promise<void>
    {
        return this.refreshProvider(provider, true);
    }

    setTrusted(trusted: boolean): void
    {
        if (this.trusted === trusted || this.disposed)
            return;
        this.trusted = trusted;
        const refresh = new Set<ProviderId>();
        for (const state of this.states.values())
        {
            this.cancel(state, trusted && state.config.enabled);
            state.status = initialStatus(state.config, trusted);
            if (!trusted)
            {
                state.status.state = ConnectionState.Unavailable;
                state.status.message = UNTRUSTED_MESSAGE;
            }
            else if (state.stoppedForTokens)
            {
                state.status.state = ConnectionState.Unsupported;
                state.status.message = TOKEN_STOP_MESSAGE;
            }
            else if (state.config.enabled && state.inflight === undefined)
                refresh.add(state.config.id);
        }
        this.syncPolling();
        this.emit();
        for (const provider of refresh)
            void this.refresh(provider);
    }

    dispose(): void
    {
        if (this.disposed)
            return;
        this.disposed = true;
        this.stopPolling();
        this.displayStop?.();
        this.displayStop = undefined;
        for (const state of this.states.values())
            this.cancel(state, false);
        this.states.clear();
    }

    private refreshProvider(provider: ProviderId, retry: boolean): Promise<void>
    {
        const state = this.states.get(provider);
        if (state === undefined || this.disposed || !this.trusted || !state.config.enabled)
            return Promise.resolve();
        if (state.stoppedForTokens && !retry)
            return Promise.resolve();
        if (state.inflight !== undefined)
            return state.inflight;

        const abort = new AbortController();
        state.abort = abort;
        state.status.refreshing = true;
        if (state.status.snapshot === undefined)
            state.status.state = ConnectionState.Loading;
        this.emit();

        let inflight: Promise<void>;
        inflight = this.readProvider(state, abort).finally(() =>
        {
            if (state.inflight !== inflight)
                return;
            state.inflight = undefined;
            if (state.abort === abort)
                state.abort = undefined;
            if (this.isCurrent(state, abort))
            {
                state.status.refreshing = false;
                this.emit();
            }
            if (state.refreshQueued)
            {
                state.refreshQueued = false;
                void this.refresh(state.config.id);
            }
        });
        state.inflight = inflight;
        return inflight;
    }

    private async readProvider(state: RuntimeState, abort: AbortController): Promise<void>
    {
        try
        {
            const report = await state.config.cli.readUsage(state.config, this.options.context(), abort.signal);
            if (!this.isCurrent(state, abort))
                return;
            state.stoppedForTokens = false;
            state.status.state = report.partial ? ConnectionState.Partial : ConnectionState.Ready;
            state.status.message = report.partial ? "Some allowance pools were not reported." : undefined;
            state.status.snapshot = { pools: report.pools, metadata: report.metadata };
            state.status.lastSuccessAt = this.options.now();
        }
        catch (error)
        {
            if (!this.isCurrent(state, abort))
                return;
            const failure = error instanceof UsageError
                ? error
                : new UsageError(ConnectionState.Unavailable, REQUEST_FAILED_MESSAGE);
            if (failure.stopPolling)
            {
                state.stoppedForTokens = true;
                state.status.state = failure.state;
                state.status.message = failure.message;
                state.status.snapshot = undefined;
                state.status.lastSuccessAt = undefined;
            }
            else
            {
                const keepsSnapshot = state.status.snapshot !== undefined
                    && failure.state !== ConnectionState.AuthRequired
                    && failure.state !== ConnectionState.MissingCli;
                state.status.state = keepsSnapshot ? ConnectionState.Stale : failure.state;
                state.status.message = failure.message;
                if (!keepsSnapshot)
                {
                    state.status.snapshot = undefined;
                    state.status.lastSuccessAt = undefined;
                }
            }
        }
        finally
        {
            if (this.isCurrent(state, abort))
            {
                state.status.refreshing = false;
                this.emit();
            }
        }
    }

    private updateInterval(intervalMs: number, staleAfterMs: number): void
    {
        if (this.intervalMs === intervalMs && this.staleAfterMs === staleAfterMs)
            return;
        this.intervalMs = intervalMs;
        this.staleAfterMs = staleAfterMs;
        this.syncPolling(true);
    }

    private syncPolling(restart = false): void
    {
        const shouldPoll = !this.disposed && this.trusted && this.intervalMs > 0
            && [...this.states.values()].some((state) => state.config.enabled);
        if (!shouldPoll)
        {
            this.stopPolling();
            return;
        }
        if (!restart && this.pollingStop !== undefined)
            return;
        this.stopPolling();
        this.pollingStop = this.options.schedule(() => void this.refreshAll(), this.intervalMs);
    }

    private stopPolling(): void
    {
        this.pollingStop?.();
        this.pollingStop = undefined;
    }

    private cancel(state: RuntimeState, refreshAfterClose: boolean): void
    {
        state.refreshQueued = refreshAfterClose && state.inflight !== undefined;
        state.abort?.abort();
        state.abort = undefined;
        state.status.refreshing = false;
    }

    private isCurrent(state: RuntimeState, abort: AbortController): boolean
    {
        return !this.disposed && this.states.get(state.config.id) === state && state.abort === abort;
    }

    private emit(): void
    {
        if (!this.disposed)
            this.options.onDidChange();
    }
}

const TOKEN_STOP_MESSAGE = "The Antigravity usage probe consumed model tokens; automatic polling is stopped.";

function initialStatus(config: ProviderConfig, trusted: boolean): ProviderStatus
{
    const disabled = !config.enabled;
    return {
        provider: config.id,
        label: config.label,
        state: disabled ? ConnectionState.Disabled : trusted ? ConnectionState.Loading : ConnectionState.Unavailable,
        message: disabled ? DISABLED_MESSAGE : trusted ? undefined : UNTRUSTED_MESSAGE,
        snapshot: undefined,
        refreshing: false,
        lastSuccessAt: undefined,
    };
}
