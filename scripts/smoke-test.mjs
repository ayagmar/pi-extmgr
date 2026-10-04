// Smoke test: loads this package the way pi does.
//   1. Every extension entry in the package.json "pi" manifest imports and default-exports a factory.
//   2. The real pi CLI (devDependency) loads the package directory in RPC mode, which runs the
//      factories and session_start without any model call. A factory that throws makes pi exit 1.
//      An event handler that throws (session_start included) is not fatal: pi reports it as an
//      `extension_error` JSON line on stdout and still exits 0, so those lines fail the test too.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const entries = pkg.pi?.extensions ?? [];

if (entries.length === 0) {
  throw new Error('package.json "pi.extensions" is empty');
}

for (const entry of entries) {
  const mod = await import(pathToFileURL(join(root, entry)).href);
  if (typeof mod.default !== "function") {
    throw new Error(`${entry}: default export is not a function`);
  }
  console.log(`✓ ${entry} exports an extension factory`);
}

const piPkgDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piPkg = JSON.parse(await readFile(join(piPkgDir, "package.json"), "utf8"));
const cli = join(piPkgDir, typeof piPkg.bin === "string" ? piPkg.bin : piPkg.bin.pi);
const agentDir = await mkdtemp(join(tmpdir(), "pi-smoke-"));

try {
  const { code, stdout, stderr } = await runRpc(cli, agentDir);
  if (code !== 0 || stderr.includes("Failed to load extension")) {
    console.error(stderr);
    throw new Error(`pi ${piPkg.version} failed to load the package (exit ${code})`);
  }
  const extensionErrors = parseExtensionErrors(stdout);
  if (extensionErrors.length > 0) {
    for (const { extensionPath, event, error } of extensionErrors) {
      console.error(`${extensionPath}: ${event} handler threw: ${error}`);
    }
    throw new Error(`pi ${piPkg.version} reported ${extensionErrors.length} extension error(s)`);
  }
  const commands = parseCommands(stdout);
  console.log(
    `✓ pi ${piPkg.version} loads the package` +
      (commands.length > 0 ? ` (commands: ${commands.join(", ")})` : "")
  );
} finally {
  await rm(agentDir, { recursive: true, force: true });
}

function runRpc(cliPath, dir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, "--mode", "rpc", "--no-extensions", "--extension", root, "--no-session"],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          PI_CODING_AGENT_DIR: dir,
          PI_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pi did not exit within 60s"));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  });
}

function parseMessages(output) {
  const messages = [];
  for (const line of output.split("\n")) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // not JSON
    }
  }
  return messages;
}

function parseCommands(output) {
  const response = parseMessages(output).find(
    (message) => message?.id === "commands" && message.success !== false
  );
  return (response?.data?.commands ?? [])
    .filter((command) => command.source === "extension")
    .map((command) => `/${command.name}`);
}

function parseExtensionErrors(output) {
  return parseMessages(output).filter((message) => message?.type === "extension_error");
}
