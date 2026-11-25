export {};

const command = Bun.argv.slice(2);
if (!command.length) process.exit(127);

const graceMs = 150;
let stop: NodeJS.Signals | undefined;
let target: ReturnType<typeof Bun.spawn> | undefined;
let done = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const finishGroup = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {}
  process.exit(143);
};

const onSignal = (name: NodeJS.Signals) => {
  if (!stop) stop = name;
  if (!target) process.exit(128);
  if (done) return;
  if ((name === "SIGTERM" || name === "SIGHUP") && !timer) timer = setTimeout(finishGroup, graceMs);
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(sig, onSignal);

try {
  target = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] });
} catch {
  process.exit(127);
}

if ((stop === "SIGTERM" || stop === "SIGHUP") && !timer) timer = setTimeout(finishGroup, graceMs);
const code = await target.exited;
done = true;
if (timer) clearTimeout(timer);
if (stop) {
  if (stop === "SIGINT" || stop === "SIGQUIT") {
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {}
    await Bun.sleep(graceMs);
  }
  finishGroup();
}
process.exit(code);
