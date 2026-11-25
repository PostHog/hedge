import { dlopen, FFIType } from "bun:ffi";

const command = Bun.argv.slice(2);
if (!command.length) process.exit(127);

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  setpgid: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  getpgrp: { args: [], returns: FFIType.i32 },
});
if (libc.symbols.setpgid(0, 0) !== 0 && libc.symbols.getpgrp() !== process.pid) process.exit(127);

const graceMs = 150;
const interruptGraceMs = 300;
let stop: NodeJS.Signals | undefined;
let target: ReturnType<typeof Bun.spawn> | undefined;
let done = false;
let escalated = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let hardTimer: ReturnType<typeof setTimeout> | undefined;
const forwarded = new Set<NodeJS.Signals>();

const finishGroup = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {}
  process.exit(143);
};

const forwardGroup = (name: NodeJS.Signals) => {
  if (forwarded.has(name)) return;
  forwarded.add(name);
  try {
    process.kill(-process.pid, name);
  } catch {}
};

const arm = (name: NodeJS.Signals) => {
  if (done) return;
  if (name === "SIGTERM" || name === "SIGHUP") {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!hardTimer) hardTimer = setTimeout(finishGroup, graceMs);
    return;
  }
  if (!timer && !hardTimer) {
    timer = setTimeout(() => {
      timer = undefined;
      escalated = true;
      if (!hardTimer) hardTimer = setTimeout(finishGroup, graceMs);
      forwardGroup("SIGTERM");
    }, interruptGraceMs);
  }
};

const onSignal = (name: NodeJS.Signals) => {
  if (!stop) stop = name;
  if (!target) process.exit(128);
  if (done) return;
  arm(name);
  forwardGroup(name);
};

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(sig, onSignal);
for (const sig of ["SIGTTIN", "SIGTTOU"] as const) process.on(sig, () => {});

try {
  target = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] });
} catch {
  process.exit(127);
}

if (stop) {
  arm(stop);
  forwardGroup(stop);
}

const code = await target.exited;
done = true;
if (timer) clearTimeout(timer);
if (hardTimer) clearTimeout(hardTimer);
if (stop) {
  if (!escalated && (stop === "SIGINT" || stop === "SIGQUIT")) {
    forwardGroup("SIGTERM");
    await Bun.sleep(graceMs);
  }
  finishGroup();
}
process.exit(code);
