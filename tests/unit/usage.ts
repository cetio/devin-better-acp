import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderCLI } from "../../source/cli";
import type { CodexConfig } from "../../source/codex/config";
import type { ExtensionConfig } from "../../source/config";
import { ConnectionState, UsageError, UsageReport, UsageService } from "../../source/usage";
import type { PollScheduler } from "../../source/poll";

class FakeIntervals
{
    private nextId = 1;
    private readonly callbacks = new Map<number, { intervalMs: number; callback: () => void }>();
    readonly intervals: number[] = [];
    now = 0;

    schedule: PollScheduler = (callback, intervalMs) =>
    {
        const id = this.nextId++;
        this.intervals.push(intervalMs);
        this.callbacks.set(id, { intervalMs, callback });
        return () =>
        {
            this.callbacks.delete(id);
        };
    };

    async fire(intervalMs: number): Promise<void>
    {
        const scheduled = [...this.callbacks.values()].find((entry) => entry.intervalMs === intervalMs);
        if (scheduled === undefined)
            return;
        this.now += intervalMs;
        scheduled.callback();
        await flush();
    }

    get pending(): number
    {
        return this.callbacks.size;
    }
}

function fakeCli(readUsage: ProviderCLI["readUsage"]): ProviderCLI
{
    return { readUsage };
}

function codexConfig(cli: ProviderCLI, changes: Partial<CodexConfig> = {}): CodexConfig
{
    return {
        id: "codex",
        label: "Codex",
        enabled: true,
        path: "",
        visible: true,
        cli,
        ...changes,
    };
}

function extensionConfig(config: CodexConfig, intervalMs = 180000): ExtensionConfig
{
    return {
        providers: [config],
        intervalMs,
        staleAfterMs: intervalMs === 0 ? Number.POSITIVE_INFINITY : intervalMs * 2,
        alignment: "right",
    };
}

function sampleReport(usedPercent = 16): UsageReport
{
    return {
        pools: [{
            id: "codex",
            label: "Codex",
            windows: [{ id: "codex:primary", label: "5h", usedPercent, durationMinutes: 300, resetsAt: undefined }],
        }],
        metadata: [],
        partial: false,
    };
}

function makeUsage(timers: FakeIntervals, options: { intervalMs?: number; trusted?: boolean } = {}): UsageService
{
    const intervalMs = options.intervalMs ?? 180000;
    return new UsageService({
        intervalMs,
        staleAfterMs: intervalMs === 0 ? Number.POSITIVE_INFINITY : intervalMs * 2,
        trusted: options.trusted ?? true,
        now: () => timers.now,
        context: () => ({
            workingDirectory: "/tmp",
            workspacePaths: [],
            environment: {},
            home: "/tmp",
            clientVersion: "1.0.0",
        }),
        schedule: timers.schedule,
        onDidChange: () => undefined,
    });
}

async function flush(): Promise<void>
{
    for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setImmediate(resolve));
}

test("startup refreshes immediately on one fixed shared cadence", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const cli = fakeCli(async () =>
    {
        calls += 1;
        return sampleReport();
    });
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(cli)));
    await flush();

    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    assert.equal(calls, 1);
    assert.deepEqual(timers.intervals, [60000, 180000]);

    await timers.fire(180000);
    assert.equal(calls, 2);
    usage.dispose();
    assert.equal(timers.pending, 0);
});

test("the display tick does not refresh provider usage", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const usage = makeUsage(timers, { intervalMs: 0 });
    usage.configure(extensionConfig(codexConfig(fakeCli(async () =>
    {
        calls += 1;
        return sampleReport();
    })), 0));
    await flush();
    await timers.fire(60000);

    assert.equal(calls, 1);
    assert.equal(usage.getState().now, 60000);
    assert.equal(usage.getState().staleAfterMs, Number.POSITIVE_INFINITY);
    usage.dispose();
});

test("simultaneous provider refreshes share one in-flight request", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    let finish: (report: UsageReport) => void = () => undefined;
    const cli = fakeCli(() =>
    {
        calls += 1;
        return new Promise((resolve) =>
        {
            finish = resolve;
        });
    });
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(cli)));
    await flush();
    const first = usage.refresh("codex");
    const second = usage.refresh("codex");
    assert.equal(calls, 1);
    finish(sampleReport());
    await Promise.all([first, second]);
    usage.dispose();
});

test("ordinary failures keep stale values and retry on the unchanged interval", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const cli = fakeCli(async () =>
    {
        calls += 1;
        if (calls === 2)
            throw new UsageError(ConnectionState.Unavailable, "offline");
        return sampleReport();
    });
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(cli)));
    await flush();

    await timers.fire(180000);
    const stale = usage.getStatuses()[0];
    assert.equal(stale?.state, ConnectionState.Stale);
    assert.equal(stale?.message, "offline");
    assert.equal(stale?.snapshot?.pools[0]?.windows[0]?.usedPercent, 16);
    assert.equal(calls, 2);

    await timers.fire(180000);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    assert.equal(calls, 3);
    usage.dispose();
});

test("a missing CLI is retried and can recover without a configuration change", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const cli = fakeCli(async () =>
    {
        calls += 1;
        if (calls === 1)
            throw new UsageError(ConnectionState.MissingCli, "Codex CLI was not found.");
        return sampleReport();
    });
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(cli)));
    await flush();
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.MissingCli);

    await timers.fire(180000);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    assert.equal(calls, 2);
    usage.dispose();
});

test("authentication failures clear cached values but do not stop scheduled retries", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const cli = fakeCli(async () =>
    {
        calls += 1;
        if (calls === 2)
            throw new UsageError(ConnectionState.AuthRequired, "Codex is not signed in.");
        return sampleReport();
    });
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(cli)));
    await flush();
    await timers.fire(180000);

    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.AuthRequired);
    assert.equal(usage.getStatuses()[0]?.snapshot, undefined);
    await timers.fire(180000);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    assert.equal(calls, 3);
    usage.dispose();
});

test("Antigravity token consumption stops polling until explicit successful retry", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const cli = fakeCli(async () =>
    {
        calls += 1;
        if (calls === 1 || calls === 3)
            throw new UsageError(ConnectionState.Unsupported, "Token usage was reported.", true);
        return sampleReport();
    });
    const usage = makeUsage(timers);
    const config = {
        ...codexConfig(cli),
        id: "antigravity" as const,
        label: "Antigravity",
        spoofZed: true,
        devinMcp: true,
        systemPrompt: true,
    };
    usage.configure({
        providers: [config],
        intervalMs: 180000,
        staleAfterMs: 360000,
        alignment: "right",
    });
    await flush();
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Unsupported);

    await timers.fire(180000);
    await usage.refresh("antigravity");
    assert.equal(calls, 1);
    await usage.retry("antigravity");
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    assert.equal(calls, 2);

    await timers.fire(180000);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Unsupported);
    await timers.fire(180000);
    assert.equal(calls, 3);
    await usage.retry("antigravity");
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    usage.dispose();
});

test("untrusted workspaces suppress startup work and refresh immediately on trust grant", async () =>
{
    const timers = new FakeIntervals();
    let calls = 0;
    const usage = makeUsage(timers, { trusted: false });
    usage.configure(extensionConfig(codexConfig(fakeCli(async () =>
    {
        calls += 1;
        return sampleReport();
    }))));
    await flush();
    assert.equal(calls, 0);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Unavailable);

    usage.setTrusted(true);
    await flush();
    assert.equal(calls, 1);
    assert.equal(usage.getStatuses()[0]?.state, ConnectionState.Ready);
    usage.dispose();
});

test("changing the CLI path cancels old work and refreshes with the new config", async () =>
{
    const timers = new FakeIntervals();
    const paths: string[] = [];
    let oldSignal: AbortSignal | undefined;
    let releaseOld: () => void = () => undefined;
    const cli = fakeCli(async (config, _context, signal) =>
    {
        paths.push(config.path);
        if (config.path.length === 0)
        {
            oldSignal = signal;
            await new Promise<void>((resolve) =>
            {
                releaseOld = resolve;
            });
            return sampleReport(10);
        }
        return sampleReport(20);
    });
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(cli)));
    await flush();
    usage.configure(extensionConfig(codexConfig(cli, { path: "/opt/codex" })));
    assert.equal(oldSignal?.aborted, true);
    releaseOld();
    await flush();

    assert.deepEqual(paths, ["", "/opt/codex"]);
    assert.equal(usage.getStatuses()[0]?.snapshot?.pools[0]?.windows[0]?.usedPercent, 20);
    usage.dispose();
});

test("disposal aborts active reads and suppresses late results", async () =>
{
    const timers = new FakeIntervals();
    let signal: AbortSignal | undefined;
    let release: (report: UsageReport) => void = () => undefined;
    const usage = makeUsage(timers);
    usage.configure(extensionConfig(codexConfig(fakeCli((_config, _context, readSignal) =>
    {
        signal = readSignal;
        return new Promise((resolve) =>
        {
            release = resolve;
        });
    }))));
    await flush();
    usage.dispose();
    assert.equal(signal?.aborted, true);
    release(sampleReport());
    await flush();
    assert.deepEqual(usage.getStatuses(), []);
    assert.equal(timers.pending, 0);
});
