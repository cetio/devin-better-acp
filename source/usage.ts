import { backoffDelayMs, earliestResetAt, isTerminal } from "./allowance/schedule";
import { sanitizeLabel } from "./allowance/format";
import {
    ConnectionState,
    expectedPoolIds,
    ProviderId,
    ProviderStatus,
} from "./allowance/model";
import { AdapterError, ProviderAdapter, ProviderSetup } from "./adapter";
import { formatVersion, parseVersion, versionAtLeast } from "./process/version";

const RESET_GRACE_MS = 5000;
const TIME_TICK_MS = 60000;

export type TimerHandle = {
    cancel: () => void;
};

export type RefreshInfo = {
    provider: ProviderId;
    state: ConnectionState;
    message: string | undefined;
    durationMs: number;
    cliVersion: string | undefined;
};

export type UsageOptions = {
    intervalMs: number;
    staleAfterMs: number;
};

export type UsageState = {
    now: number;
    staleAfterMs: number;
    statuses: ProviderStatus[];
};

export type UsageServiceOptions = UsageOptions & {
    now: () => number;
    random: () => number;
    setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
    onDidChange: () => void;
    onRefresh: (info: RefreshInfo) => void;
};

type VersionVerdict = {
    text: string;
    supported: boolean;
    message: string | undefined;
};

type RuntimeState = {
    setup: ProviderSetup;
    signature: string;
    status: ProviderStatus;
    timer: TimerHandle | undefined;
    abort: AbortController | undefined;
    inflight: Promise<void> | undefined;
    generation: number;
    failures: number;
    versionVerdict: VersionVerdict | undefined;
};

export class UsageService
{
    private readonly options: UsageServiceOptions;
    private readonly states = new Map<ProviderId, RuntimeState>();
    private nextGenerationId = 1;
    private focused = true;
    private paused: string | undefined;
    private clockTimer: TimerHandle | undefined;
    private disposed = false;

    constructor(options: UsageServiceOptions)
    {
        this.options = options;
    }

    configure(setups: ProviderSetup[], options?: UsageOptions): void
    {
        if (options !== undefined)
            this.setOptions(options, false);
        const seen = new Set<ProviderId>();
        for (const setup of setups)
        {
            seen.add(setup.provider);
            const signature = setupSignature(setup);
            const existing = this.states.get(setup.provider);
            if (existing !== undefined && existing.signature === signature)
            {
                existing.setup = setup;
                continue;
            }
            if (existing !== undefined)
                this.reset(existing);
            this.states.set(setup.provider, this.createState(setup, signature));
        }
        for (const [provider, state] of [...this.states])
        {
            if (seen.has(provider))
                continue;
            this.reset(state);
            this.states.delete(provider);
        }
        this.emit();
        for (const state of this.states.values())
            this.start(state);
    }

    getState(): UsageState
    {
        return {
            statuses: this.getStatuses(),
            now: this.options.now(),
            staleAfterMs: this.options.staleAfterMs,
        };
    }

    getStatuses(): ProviderStatus[]
    {
        return [...this.states.values()].map((state) => state.status);
    }

    refreshAll(options: { manual?: boolean } = {}): Promise<void>
    {
        const refreshes = [...this.states.keys()].map((provider) => this.refresh(provider, options));
        return Promise.all(refreshes).then(() => undefined);
    }

    refresh(provider: ProviderId, options: { manual?: boolean } = {}): Promise<void>
    {
        const state = this.states.get(provider);
        if (state === undefined || this.disposed || this.paused !== undefined)
            return Promise.resolve();
        if (!state.setup.enabled || state.setup.adapter === undefined)
            return Promise.resolve();
        if (state.inflight !== undefined)
            return state.inflight;
        const inflight = this.runRefresh(state, options.manual === true).finally(() =>
        {
            if (state.inflight === inflight)
                state.inflight = undefined;
        });
        state.inflight = inflight;
        return inflight;
    }

    setFocused(focused: boolean): void
    {
        if (this.focused === focused)
            return;
        this.focused = focused;
        if (!focused)
        {
            for (const state of this.states.values())
            {
                if (state.timer !== undefined)
                {
                    state.timer.cancel();
                    state.timer = undefined;
                }
            }
            return;
        }
        const now = this.options.now();
        const intervalMs = this.options.intervalMs;
        for (const state of this.states.values())
        {
            if (!state.setup.enabled || state.setup.adapter === undefined || this.paused !== undefined)
                continue;
            const lastAttemptAt = state.status.lastAttemptAt;
            if (intervalMs > 0 && lastAttemptAt !== undefined && now - lastAttemptAt >= intervalMs)
                void this.refresh(state.setup.provider);
            else
                this.scheduleNext(state);
        }
    }

    setPaused(message: string | undefined): void
    {
        if (this.paused === message)
            return;
        this.paused = message;
        for (const state of this.states.values())
        {
            this.cancelWork(state);
            state.generation = this.nextGenerationId++;
            if (message !== undefined)
            {
                this.patch(state, {
                    state: ConnectionState.Unavailable,
                    message,
                    snapshot: undefined,
                    refreshing: false,
                });
            }
            else
                this.patch(state, { state: ConnectionState.Loading, message: undefined, refreshing: false });
        }
        this.emit();
        if (message === undefined)
        {
            for (const state of this.states.values())
                this.start(state);
        }
    }

    dispose(): void
    {
        this.disposed = true;
        for (const state of this.states.values())
        {
            this.cancelWork(state);
            state.generation = this.nextGenerationId++;
        }
        this.states.clear();
        this.cancelClock();
    }

    private createState(setup: ProviderSetup, signature: string): RuntimeState
    {
        return {
            setup,
            signature,
            status: initialStatus(setup),
            timer: undefined,
            abort: undefined,
            inflight: undefined,
            generation: this.nextGenerationId++,
            failures: 0,
            versionVerdict: undefined,
        };
    }

    private start(state: RuntimeState): void
    {
        if (this.disposed)
            return;
        if (this.paused !== undefined)
        {
            this.patch(state, {
                state: ConnectionState.Unavailable,
                message: this.paused,
                snapshot: undefined,
                refreshing: false,
            });
            return;
        }
        if (!state.setup.enabled)
        {
            this.patch(state, {
                state: ConnectionState.Disabled,
                message: "Usage monitoring is disabled in settings.",
                snapshot: undefined,
                refreshing: false,
            });
            return;
        }
        if (state.setup.adapter === undefined)
        {
            this.patch(state, {
                state: ConnectionState.MissingCli,
                message: state.setup.message,
                snapshot: undefined,
                refreshing: false,
            });
            return;
        }
        void this.refresh(state.setup.provider);
    }

    private async runRefresh(state: RuntimeState, manual: boolean): Promise<void>
    {
        const adapter = state.setup.adapter;
        if (adapter === undefined)
            return;
        const generation = state.generation;
        const abort = new AbortController();
        state.abort = abort;
        const startedAt = this.options.now();
        this.patch(state, { refreshing: true, lastAttemptAt: startedAt });
        try
        {
            const verdict = await this.resolveVersion(state, adapter, manual, abort.signal);
            if (!this.isCurrent(state, generation))
                return;
            if (verdict !== undefined && !verdict.supported && !manual)
            {
                this.patch(state, {
                    state: ConnectionState.Unsupported,
                    message: verdict.message,
                    cliVersion: verdict.text,
                    snapshot: undefined,
                    refreshing: false,
                });
                return;
            }
            const result = await adapter.read(abort.signal);
            if (!this.isCurrent(state, generation))
                return;
            const missing = expectedPoolIds(state.setup.provider)
                .some((poolId) => !result.pools.some((pool) => pool.id === poolId));
            this.patch(state, {
                state: missing ? ConnectionState.Partial : ConnectionState.Ready,
                message: missing ? "Some allowance pools were not reported." : undefined,
                snapshot: { observedAt: result.observedAt, pools: result.pools, metadata: result.metadata },
                refreshing: false,
                lastSuccessAt: this.options.now(),
            });
            state.failures = 0;
        }
        catch (error)
        {
            if (!this.isCurrent(state, generation))
                return;
            state.failures += 1;
            const failure = error instanceof AdapterError
                ? error
                : new AdapterError(ConnectionState.Unavailable, "The usage request failed.");
            const keepSnapshot = failure.state === ConnectionState.Unavailable && state.status.snapshot !== undefined;
            this.patch(state, {
                state: keepSnapshot ? ConnectionState.Stale : failure.state,
                message: failure.message,
                snapshot: keepSnapshot ? state.status.snapshot : undefined,
                refreshing: false,
            });
        }
        finally
        {
            if (state.abort === abort)
                state.abort = undefined;
            if (this.isCurrent(state, generation))
            {
                this.scheduleNext(state);
                this.options.onRefresh({
                    provider: state.setup.provider,
                    state: state.status.state,
                    message: state.status.message,
                    durationMs: this.options.now() - startedAt,
                    cliVersion: state.status.cliVersion,
                });
            }
            this.emit();
        }
    }

    private async resolveVersion(
        state: RuntimeState,
        adapter: ProviderAdapter,
        manual: boolean,
        signal: AbortSignal,
    ): Promise<VersionVerdict | undefined>
    {
        if (state.versionVerdict !== undefined && !manual)
            return state.versionVerdict;
        const text = await adapter.version(signal);
        const version = parseVersion(text);
        let verdict: VersionVerdict;
        if (version === undefined)
        {
            const unsupported = adapter.minimumVersion === undefined;
            verdict = {
                text: sanitizeLabel(text),
                supported: unsupported,
                message: unsupported ? undefined : `Could not determine the ${state.setup.label} CLI version.`,
            };
        }
        else if (adapter.minimumVersion !== undefined && !versionAtLeast(version, adapter.minimumVersion))
        {
            const current = formatVersion(version);
            const minimum = formatVersion(adapter.minimumVersion);
            const message = `${state.setup.label} CLI ${current} is older than the verified ${minimum}; `
                + "automatic polling is paused. Update the CLI, then use Retry Connection.";
            verdict = { text: current, supported: false, message };
        }
        else
        {
            verdict = { text: formatVersion(version), supported: true, message: undefined };
        }
        state.versionVerdict = verdict;
        this.patch(state, { cliVersion: verdict.text });
        return verdict;
    }

    private scheduleNext(state: RuntimeState): void
    {
        if (state.timer !== undefined)
        {
            state.timer.cancel();
            state.timer = undefined;
        }
        if (this.disposed || this.paused !== undefined || !this.focused || !state.setup.enabled)
            return;
        const intervalMs = this.options.intervalMs;
        if (intervalMs <= 0 || isTerminal(state.status.state))
            return;
        const now = this.options.now();
        const base = backoffDelayMs(intervalMs, state.failures);
        let delay = base + Math.floor(base * 0.05 * this.options.random());
        const resetAt = earliestResetAt(state.status.snapshot, now);
        if (resetAt !== undefined)
        {
            const resetDelay = resetAt + RESET_GRACE_MS - now;
            if (resetDelay > 0 && resetDelay < delay)
                delay = resetDelay;
        }
        state.timer = this.options.setTimeout(() =>
        {
            state.timer = undefined;
            void this.refresh(state.setup.provider);
        }, delay);
    }

    private cancelWork(state: RuntimeState): void
    {
        if (state.timer !== undefined)
        {
            state.timer.cancel();
            state.timer = undefined;
        }
        if (state.abort !== undefined)
        {
            state.abort.abort();
            state.abort = undefined;
        }
    }

    private cancelClock(): void
    {
        if (this.clockTimer === undefined)
            return;
        this.clockTimer.cancel();
        this.clockTimer = undefined;
    }

    private reset(state: RuntimeState): void
    {
        this.cancelWork(state);
        state.generation = this.nextGenerationId++;
        state.versionVerdict = undefined;
        state.failures = 0;
    }

    private isCurrent(state: RuntimeState, generation: number): boolean
    {
        return !this.disposed && state.generation === generation;
    }

    private patch(state: RuntimeState, changes: Partial<ProviderStatus>): void
    {
        Object.assign(state.status, changes);
        this.emit();
    }

    private emit(): void
    {
        if (this.disposed)
            return;
        if (this.getStatuses().some((status) => status.snapshot !== undefined))
        {
            if (this.clockTimer === undefined)
            {
                this.clockTimer = this.options.setTimeout(() =>
                {
                    this.clockTimer = undefined;
                    this.emit();
                }, TIME_TICK_MS);
            }
        }
        else
            this.cancelClock();
        this.options.onDidChange();
    }

    private setOptions(options: UsageOptions, notify: boolean): void
    {
        const intervalChanged = this.options.intervalMs !== options.intervalMs;
        const staleChanged = this.options.staleAfterMs !== options.staleAfterMs;
        if (!intervalChanged && !staleChanged)
            return;
        this.options.intervalMs = options.intervalMs;
        this.options.staleAfterMs = options.staleAfterMs;
        if (intervalChanged)
        {
            for (const state of this.states.values())
                this.scheduleNext(state);
        }
        if (notify)
            this.emit();
    }
}

function initialStatus(setup: ProviderSetup): ProviderStatus
{
    return {
        provider: setup.provider,
        label: setup.label,
        state: setup.enabled ? ConnectionState.Loading : ConnectionState.Disabled,
        message: setup.enabled ? undefined : "Usage monitoring is disabled in settings.",
        cliVersion: undefined,
        snapshot: undefined,
        refreshing: false,
        lastAttemptAt: undefined,
        lastSuccessAt: undefined,
    };
}

function setupSignature(setup: ProviderSetup): string
{
    const adapter = setup.adapter;
    if (adapter === undefined)
        return [setup.enabled ? "on" : "off", "none", setup.message ?? ""].join("|");
    return [setup.enabled ? "on" : "off", adapter.command, adapter.readArgs.join(" ")].join("|");
}
