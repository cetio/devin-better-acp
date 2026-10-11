export type PollScheduler = (callback: () => void, intervalMs: number) => (() => void) | undefined;

export function startPolling(callback: () => void, intervalMs: number): (() => void) | undefined
{
    if (!Number.isFinite(intervalMs) || intervalMs <= 0)
        return undefined;
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
