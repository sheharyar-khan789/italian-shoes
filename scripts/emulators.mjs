/**
 * Start the Firebase emulators, or run a command against them.
 *
 *   node scripts/emulators.mjs start                 → emulators + UI at http://localhost:4000
 *   node scripts/emulators.mjs exec "<command>"      → start, run the command, stop
 *
 * Always uses the "demo-italianshoes" project id, so the emulators cannot reach any real
 * Firebase service. Takes care of this machine's Java quirks: the Firestore emulator needs a
 * recent JDK first on PATH, and Java's Unix-domain sockets need a short temp directory on Windows.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Pinned devDependency (package.json); resolved from node_modules/.bin.
const FIREBASE_TOOLS = "firebase";
const PROJECT = "demo-italianshoes";
const [mode, command] = process.argv.slice(2);

if (!["start", "exec"].includes(mode) || (mode === "exec" && !command)) {
  console.error('Usage: node scripts/emulators.mjs start | exec "<command>"');
  process.exit(1);
}

const env = { ...process.env };
// Loading the functions (with the image library) can take longer than the CLI's 10-second default
// on a busy machine, which made the Functions emulator fail to start intermittently.
env.FUNCTIONS_DISCOVERY_TIMEOUT ??= "90";

if (process.platform === "win32") {
  // Prefer the newest Eclipse Adoptium JDK (21+) if one is installed.
  const base = "C:\\Program Files\\Eclipse Adoptium";
  if (existsSync(base)) {
    const jdk = readdirSync(base)
      .filter((d) => /^jdk-(\d+)/.test(d) && Number(/^jdk-(\d+)/.exec(d)[1]) >= 21)
      .sort((a, b) => Number(/^jdk-(\d+)/.exec(b)[1]) - Number(/^jdk-(\d+)/.exec(a)[1]))[0];
    if (jdk) {
      const bin = path.join(base, jdk, "bin");
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
      env[pathKey] = `${bin};${env[pathKey] ?? ""}`;
      env.JAVA_HOME = path.join(base, jdk);
    }
  }
  env.JAVA_TOOL_OPTIONS = [env.JAVA_TOOL_OPTIONS, "-Djdk.net.unixdomain.tmpdir=C:\\Windows\\Temp"].filter(Boolean).join(" ");
}

/**
 * Quote one argument for the shell (Windows needs a shell to start npx.cmd). Shell escaping rules
 * differ between cmd.exe and sh, so instead of escaping we refuse any shell metacharacter outright.
 */
const quote = (arg) => {
  if (/^[\w@./:=-]+$/.test(arg)) return arg;
  // Inside double quotes, "*" is left alone by sh and cmd.exe; node --test expands it itself.
  if (!/^[\w@./:=\- *]+$/.test(arg)) throw new Error(`Refusing to pass unsafe characters to the shell: ${arg}`);
  return `"${arg}"`;
};

/**
 * Runs a fixed command. Arguments are quoted explicitly and joined into one command line, rather
 * than handing an args array to a shell unescaped (Node's DEP0190).
 * @param {string} cmd @param {string[]} args
 */
const run = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn([cmd, ...args].map(quote).join(" "), { stdio: "inherit", env, shell: true });
    child.on("exit", (code) => resolve(code ?? 1));
  });

// Functions import /shared through a generated copy; refresh it first.
const synced = await run("node", ["functions/scripts/sync-shared.mjs"]);
if (synced !== 0) process.exit(synced);

const args = ["--no-install", FIREBASE_TOOLS, mode === "start" ? "emulators:start" : "emulators:exec", "--project", PROJECT];
if (mode === "exec") args.push(command);
process.exit(await run("npx", args));
