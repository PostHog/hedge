import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv } from "../../../../src/testing/git.ts";
import { writeHome } from "../../../hub/lib/testing.ts";
import type { DreamIo } from "./command.ts";

export const dreamNow = Date.parse("2026-11-05T04:10:00Z");
export const dreamSettings = { "hub.alias": "my-hub", "hub.dreamSessions": 150, "memory.repo": "me/notes", "memory.subtree": "memory" };

export function note(name: string, fields: Record<string, string> = {}, body = "A fact.") {
  const extra = Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join("");
  return `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  type: project\n${extra}---\n${body}\n`;
}

export function hubWithSubtree(home: string, files: Record<string, string> = {}) {
  const prefixed = Object.fromEntries(Object.entries(files).map(([path, text]) => [`.agents/memory-repo/memory/${path}`, text]));
  writeHome(home, { ".config/hedge/machine.json": JSON.stringify({ schema: 1, role: "hub" }), ".agents/memory-repo/README.md": "# Notes\n", ...prefixed });
  symlinkSync(join(home, ".agents/memory-repo/memory"), join(home, ".agents/memory"));
}

export async function realGit(args: string[]) {
  const child = Bun.spawn(["git", ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

export function quietIo(home: string, fields: Partial<DreamIo> = {}) {
  const printed: string[] = [];
  const said: string[] = [];
  const offline = () => { throw new Error("this command reaches no other machine and asks no model"); };
  const io: DreamIo = {
    home, env: { HEDGE_SETTINGS: JSON.stringify(dreamSettings) }, self: "hub-host", now: () => dreamNow,
    print: (text) => void printed.push(text), say: (text) => void said.push(text),
    cwd: home, peers: () => [], onPeer: offline, boxes: () => undefined, git: offline, analyst: offline, checker: offline, launch: offline,
    ...fields,
  };
  return { io, printed, said };
}

const flakySigner = (timeouts: string) => `#!/bin/sh
case " $* " in
  *" -Y sign "*)
    left=$(cat "${timeouts}")
    if [ "$left" -gt 0 ]; then
      echo $((left - 1)) > "${timeouts}"
      echo "curl: (28) Operation timed out after 10002 milliseconds with 0 bytes received" >&2
      exit 1
    fi
    ;;
esac
exec ssh-keygen "$@"
`;

export function signCommits(repo: string, dir: string) {
  const key = join(dir, "signer");
  const counter = join(dir, "timeouts");
  const program = join(dir, "sign.sh");
  Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "dream test", "-f", key]);
  const timeOut = (times: number) => writeFileSync(counter, `${times}\n`);
  timeOut(0);
  writeFileSync(program, flakySigner(counter), { mode: 0o755 });
  for (const [name, value] of [["gpg.format", "ssh"], ["user.signingkey", key], ["gpg.ssh.program", program], ["commit.gpgsign", "true"]]) git(repo, "config", name!, value!);
  return { timeOut };
}

export const isSigned = (repo: string, commit: string) => git(repo, "cat-file", "commit", commit).includes("-----BEGIN SSH SIGNATURE-----");
