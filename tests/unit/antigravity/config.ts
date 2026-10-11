import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { test } from "node:test";

import {
    antigravityLaunchConfigPath,
    readAntigravityConfig,
    writeAntigravityLaunchSettings,
} from "../../../source/antigravity/config";
import type { ConfigurationReader } from "../../../source/config";
import { antigravityCLI } from "../../../source/antigravity/cli";
import { tempDir } from "../../support";

function reader(values: Record<string, unknown> = {}, globalValues: Record<string, unknown> = {}): ConfigurationReader
{
    return {
        get: (key: string) => values[key],
        inspect: (key: string) => globalValues[key] === undefined ? undefined : { globalValue: globalValues[key] },
    } as unknown as ConfigurationReader;
}

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}

test("Antigravity owns its CLI reference, defaults, and extension-only settings", () =>
{
    const config = readAntigravityConfig(reader());
    assert.equal(config.id, "antigravity");
    assert.equal(config.cli, antigravityCLI);
    assert.equal(config.enabled, true);
    assert.equal(config.spoofZed, true);
    assert.equal(config.devinMcp, true);
    assert.equal(config.systemPrompt, true);

    const changed = readAntigravityConfig(reader({
        "antigravity.enabled": false,
        "antigravity.path": "/usr/local/bin/agy",
        "antigravity.spoofZed": false,
        "antigravity.devinMcp": false,
        "antigravity.systemPrompt": false,
    }));
    assert.equal(changed.enabled, false);
    assert.equal(changed.path, "/usr/local/bin/agy");
    assert.equal(changed.spoofZed, false);
    assert.equal(changed.devinMcp, false);
    assert.equal(changed.systemPrompt, false);
});

test("the shim settings snapshot contains only three booleans and is private and atomic", async (context) =>
{
    const home = tempDir("devin-better-acp-antigravity-config-");
    context.after(() => removeDirectory(home));
    const path = antigravityLaunchConfigPath(home);
    const settings = { spoofZed: false, devinMcp: true, systemPrompt: false };
    await writeAntigravityLaunchSettings(settings, path);

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), settings);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    await writeAntigravityLaunchSettings(settings, path);
    await writeAntigravityLaunchSettings({ spoofZed: true, devinMcp: false, systemPrompt: true }, path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        spoofZed: true,
        devinMcp: false,
        systemPrompt: true,
    });
});
