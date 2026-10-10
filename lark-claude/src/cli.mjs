import fs from "node:fs";
import path from "node:path";
import { loadChildEnvironment, loadConfig, projectRoot } from "./config.mjs";
import { runProcess } from "./process-utils.mjs";
import { Store } from "./store.mjs";

const command = process.argv[2] || "status";
if (command !== "status") throw new Error(`未知命令：${command}`);

const config = loadConfig();
const healthPath = path.join(projectRoot, "run", "health.json");
const health = fs.existsSync(healthPath) ? JSON.parse(fs.readFileSync(healthPath, "utf8")) : null;
const lark = await runProcess(config.gateway.executables.larkCli, ["event", "status", "--json"], {
  env: loadChildEnvironment(),
  timeoutMs: 30000,
});
let eventBus;
try { eventBus = JSON.parse(lark.stdout || lark.stderr); } catch { eventBus = { ok: false, output: lark.stderr || lark.stdout }; }
const store = new Store();
const sessions = store.listSessions(10);
store.close();
console.log(JSON.stringify({ health, eventBus, sessions }, null, 2));
