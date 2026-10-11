import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { antigravityInstallPaths, installAntigravity, registryWithEntry } from "../../../source/antigravity/install";
import { tempDir, writeScript } from "../../support";

import { join, resolve } from "node:path";

function registryEntry(): Record<string, unknown>
{
    return {
        id: "devin-better-antigravity",
        distribution: {
            binary: {
                "linux-x86_64": { args: ["/source/acp.py", "--server", "/server/agy.par"] },
                "darwin-arm64": { args: ["/source/acp.py"] },
            },
        },
    };
}

function environment(directory: string, python: string, serverPath: string): NodeJS.ProcessEnv
{
    return {
        ...process.env,
        PYTHON: python,
        AGY_ACP_SERVER_PATH: serverPath,
        DEVIN_BETTER_ACP_INSTALL_DIR: join(directory, "install"),
        DEVIN_ACP_REGISTRY_PATH: join(directory, "config", "registry.json"),
    };
}

function removeDirectory(path: string): void
{
    rmSync(path, { recursive: true, force: true });
}

test("registry generation replaces matching agents and redirects every platform to the installed shim", () =>
{
    const entry = registryEntry();
    const originalEntry = JSON.stringify(entry);
    const registryText = registryWithEntry({
        version: "1.0.0",
        agents: [
            { id: "before" },
            { id: "antigravity-devin" },
            { id: "after" },
            { id: "devin-better-antigravity" },
        ],
    }, entry, "/install/source/antigravity/acp.py");
    const registry = JSON.parse(registryText) as {
        agents: Array<{ id: string; distribution?: { binary?: Record<string, { args: string[] }> } }>;
    };

    assert.deepEqual(registry.agents.map((agent) => agent.id), ["before", "devin-better-antigravity", "after"]);
    assert.equal(
        registry.agents[1]?.distribution?.binary?.["linux-x86_64"]?.args[0],
        "/install/source/antigravity/acp.py",
    );
    assert.equal(JSON.stringify(entry), originalEntry);
    assert.throws(() => registryWithEntry({ agents: {} }, entry, "/install/acp.py"), /Invalid ACP registry/);
});

test("the install command deploys the Python package and atomically updates the ACP registry", async (context) =>
{
    const directory = tempDir("devin-better-acp-install-");
    context.after(() => removeDirectory(directory));
    const extensionRoot = resolve(__dirname, "../../../../");
    const serverPath = join(directory, "agy_acp_server.par");
    const registryPath = join(directory, "config", "registry.json");
    const installDirectory = join(directory, "install");
    writeFileSync(serverPath, "server");
    mkdirSync(join(installDirectory, "source", "antigravity"), { recursive: true });
    writeFileSync(join(installDirectory, "source", "antigravity", "presentation.py"), "previous module");
    mkdirSync(join(directory, "config"), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({
        version: "1.0.0",
        agents: [{ id: "before" }, { id: "antigravity-devin" }, { id: "after" }],
    }));
    chmodSync(registryPath, 0o600);
    const python = writeScript(
        directory,
        "python.cjs",
        `if (!process.argv.includes("--system-prompt")) process.exit(3);
        process.stdout.write(${JSON.stringify(JSON.stringify(registryEntry()))});`,
    );

    const installed = await installAntigravity(
        extensionRoot,
        environment(directory, python, serverPath),
        directory,
    );
    const paths = antigravityInstallPaths(environment(directory, python, serverPath), directory);
    const sourceRoot = join(extensionRoot, "source");
    const installedRoot = join(installDirectory, "source");
    const moduleNames = readdirSync(join(sourceRoot, "antigravity")).filter((name) => name.endsWith(".py"));

    assert.equal(installed.installDirectory, installDirectory);
    assert.equal(installed.registryPath, registryPath);
    assert.deepEqual(paths, {
        installDirectory,
        shimPath: join(installDirectory, "source", "antigravity", "acp.py"),
        serverPath,
        registryPath,
    });
    assert.equal(
        readFileSync(join(installedRoot, "__init__.py"), "utf8"),
        readFileSync(join(sourceRoot, "__init__.py"), "utf8"),
    );
    for (const moduleName of moduleNames)
    {
        assert.equal(
            readFileSync(join(installedRoot, "antigravity", moduleName), "utf8"),
            readFileSync(join(sourceRoot, "antigravity", moduleName), "utf8"),
        );
    }
    assert.equal(statSync(join(installedRoot, "antigravity", "acp.py")).mode & 0o777, 0o755);
    for (const moduleName of readdirSync(join(sourceRoot, "antigravity", "presentation"))
        .filter((name) => name.endsWith(".py")))
    {
        assert.equal(
            readFileSync(join(installedRoot, "antigravity", "presentation", moduleName), "utf8"),
            readFileSync(join(sourceRoot, "antigravity", "presentation", moduleName), "utf8"),
        );
    }
    assert.equal(readdirSync(join(installedRoot, "antigravity")).includes("presentation.py"), false);
    for (const moduleName of readdirSync(join(sourceRoot, "mcp")).filter((name) => name.endsWith(".py")))
    {
        assert.equal(
            readFileSync(join(installedRoot, "mcp", moduleName), "utf8"),
            readFileSync(join(sourceRoot, "mcp", moduleName), "utf8"),
        );
    }

    assert.equal(statSync(join(installedRoot, "mcp", "server.py")).mode & 0o777, 0o755);
    assert.equal(statSync(registryPath).mode & 0o777, 0o600);

    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        agents: Array<{ id: string; distribution?: { binary?: Record<string, { args: string[] }> } }>;
    };
    assert.deepEqual(registry.agents.map((agent) => agent.id), ["before", "devin-better-antigravity", "after"]);
    assert.equal(registry.agents[1]?.distribution?.binary?.["linux-x86_64"]?.args[0], paths.shimPath);
});

test("Python failure details are not surfaced to the command", async (context) =>
{
    const directory = tempDir("devin-better-acp-install-");
    context.after(() => removeDirectory(directory));
    const serverPath = join(directory, "agy_acp_server.par");
    writeFileSync(serverPath, "server");
    const python = writeScript(directory, "python.cjs", "process.stderr.write('private-details'); process.exit(2);");
    const extensionRoot = resolve(__dirname, "../../../../");

    await assert.rejects(
        installAntigravity(extensionRoot, environment(directory, python, serverPath), directory),
        (error: unknown) => error instanceof Error
            && error.message.includes("Could not generate the ACP registry entry.")
            && !error.message.includes("private-details"),
    );
});
