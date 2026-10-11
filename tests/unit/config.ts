import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { readExtensionConfig, intervalMilliseconds } from "../../source/config";
import type { ConfigurationReader } from "../../source/config";
import { DEFAULT_INTERVAL_SECONDS } from "../../source/config";
import { codexCLI } from "../../source/codex/cli";
import { antigravityCLI } from "../../source/antigravity/cli";

function reader(values: Record<string, unknown> = {}, globalValues: Record<string, unknown> = {}): ConfigurationReader
{
    return {
        get: (key: string) => values[key],
        inspect: (key: string) => globalValues[key] === undefined ? undefined : { globalValue: globalValues[key] },
    } as unknown as ConfigurationReader;
}

test("global config references provider-owned CLI/config values in stable order", () =>
{
    const config = readExtensionConfig(reader());
    assert.equal(config.providers[0]?.id, "codex");
    assert.equal(config.providers[0]?.cli, codexCLI);
    assert.equal(config.providers[0]?.enabled, true);
    assert.equal(config.providers[1]?.id, "antigravity");
    assert.equal(config.providers[1]?.cli, antigravityCLI);
    assert.equal(config.providers[1]?.enabled, true);
    assert.equal(config.providers[1]?.id === "antigravity" && config.providers[1].spoofZed, true);
    assert.equal(config.providers[1]?.id === "antigravity" && config.providers[1].devinMcp, true);
    assert.equal(config.providers[1]?.id === "antigravity" && config.providers[1].systemPrompt, true);
    assert.equal(config.intervalMs, DEFAULT_INTERVAL_SECONDS * 1000);
    assert.equal(config.staleAfterMs, DEFAULT_INTERVAL_SECONDS * 2000);
});

test("settings preserve explicit false and the legacy status-bar visibility fallback", () =>
{
    const config = readExtensionConfig(reader({
        "codex.enabled": false,
        "codex.path": "  /opt/codex  ",
        "antigravity.enabled": true,
        "antigravity.path": " /opt/agy ",
        "antigravity.spoofZed": false,
        "antigravity.devinMcp": false,
        "antigravity.systemPrompt": false,
        "statusBar.alignment": "left",
        "statusBar.showCodex": false,
    }, {
        "statusBar.showAntigravity": false,
        "statusBar.showGemini": true,
        "statusBar.showOther": true,
    }));

    assert.equal(config.providers[0]?.enabled, false);
    assert.equal(config.providers[0]?.path, "/opt/codex");
    assert.equal(config.providers[0]?.visible, false);
    assert.equal(config.providers[1]?.path, "/opt/agy");
    assert.equal(config.providers[1]?.visible, false);
    assert.equal(config.providers[1]?.id === "antigravity" && config.providers[1].spoofZed, false);
    assert.equal(config.providers[1]?.id === "antigravity" && config.providers[1].devinMcp, false);
    assert.equal(config.providers[1]?.id === "antigravity" && config.providers[1].systemPrompt, false);
    assert.equal(config.alignment, "left");

    const legacy = readExtensionConfig(reader({}, { "statusBar.showGemini": false, "statusBar.showOther": true }));
    assert.equal(legacy.providers[1]?.visible, true);
});

test("poll intervals accept shorter positive values and cap native timer overflow", () =>
{
    assert.equal(intervalMilliseconds(undefined), 180000);
    assert.equal(intervalMilliseconds(Number.NaN), 180000);
    assert.equal(intervalMilliseconds(0), 0);
    assert.equal(intervalMilliseconds(-1), 0);
    assert.equal(intervalMilliseconds(5), 5000);
    assert.equal(intervalMilliseconds(0.0001), 1);
    assert.equal(intervalMilliseconds(1e100), 2 ** 31 - 1);
});

test("manifest groups expose the default cadence and launch-only Antigravity toggles", () =>
{
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8")) as {
        contributes: { configuration: Array<{ title: string; properties: Record<string, { default: unknown }> }> };
    };
    const groups = manifest.contributes.configuration;
    const main = groups.find((group) => group.title === "Devin Better ACP");
    const antigravity = groups.find((group) => group.title === "Devin Better Antigravity");
    assert.ok(main !== undefined && antigravity !== undefined);
    assert.equal(main.properties["devinBetterACP.refreshIntervalSeconds"]?.default, 180);
    assert.equal(antigravity.properties["devinBetterACP.antigravity.spoofZed"]?.default, true);
    assert.equal(antigravity.properties["devinBetterACP.antigravity.devinMcp"]?.default, true);
    assert.equal(antigravity.properties["devinBetterACP.antigravity.systemPrompt"]?.default, true);
});
