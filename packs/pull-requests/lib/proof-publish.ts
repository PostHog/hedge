import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readComment, type Run } from "./pr-ci.ts";
import { entries, isScreenshot, proofDirectory, proofName, saveProof, writeJson, type ProofIdentity } from "./proof.ts";

export type GitHub = (path: string, body?: unknown, method?: string) => Promise<unknown>;

async function cached(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export const publishedSuffix = ".published.json";
const publishedRecord = (saved: string, repository: string) => `${saved}.${repository.replace("/", "_")}${publishedSuffix}`;

export async function publishedUrl(saved: string) {
  const [directory, name] = [dirname(saved), basename(saved)];
  for (const record of (await entries(directory)).filter((file) => file.startsWith(`${name}.`) && file.endsWith(publishedSuffix)).sort()) {
    const url = (await cached(join(directory, record)))?.url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

export const attachedSuffix = `.pr-attachment${publishedSuffix}`;
const attachedRecord = (directory: string, name: string) => join(directory, `${name}${attachedSuffix}`);
const attachLimit = 50;
const attachBytes = 10 * 1024 * 1024;
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Shot = { source: string; name: string; bytes: Buffer };
type Staged = { name: string; path: string };

async function savedScreenshot(home: string, identity: ProofIdentity, source: string) {
  const saved = await saveProof(home, identity, source);
  const bytes = await readFile(saved);
  if (!isScreenshot(saved, bytes)) throw new Error("Publish only screenshots with invented test data");
  return { saved, bytes };
}

async function screenshot(source: string): Promise<Shot> {
  const bytes = await readFile(source);
  if (!isScreenshot(source, bytes)) throw new Error("Publish only screenshots with invented test data");
  if (bytes.length > attachBytes) throw new Error(`${source} is larger than 10 MiB, which gh cannot attach. Make the screenshot smaller, or publish it with --asset-repo <owner/fork>`);
  return { source, name: proofName(source, bytes), bytes };
}

async function staged({ name, bytes }: Shot, staging: string): Promise<Staged> {
  const path = join(staging, name);
  await writeFile(path, bytes, { mode: 0o600 });
  return { name, path };
}

function linksIn(body: string, names: string[]) {
  return new Map(names.flatMap((name) => {
    const url = new RegExp(`!\\[${escaped(name)}\\]\\((https://\\S+?)\\)`).exec(body)?.[1];
    return url ? [[name, url] as const] : [];
  }));
}

async function readBack(identity: ProofIdentity, directory: string, comment: string, names: string[], gh: Run) {
  let body: string;
  try { body = readComment(comment, gh).body; }
  catch (error) { throw new Error(`gh posted ${comment}, but Hedge could not read its links back: ${firstLine((error as Error).message)}. Delete that comment before you run hedge proof publish again`); }
  const links = linksIn(body, names);
  for (const [name, url] of links) await writeJson(attachedRecord(directory, name), { ...identity, comment, url });
  return links;
}

const refusal = (identity: ProofIdentity, stderr: string) => `gh could not attach the screenshots to ${identity.repository}#${identity.pr}: ${firstLine(stderr) || "gh named no comment"}. ${/write access|unsupported authentication/i.test(stderr)
  ? "When gh cannot attach to this PR, publish to a public repository of your own with --asset-repo <owner/fork>"
  : "Attaching needs gh 2.100.0 or newer, signed in to GitHub (gh auth status)"}`;

async function attach(identity: ProofIdentity, directory: string, shots: Staged[], gh: Run) {
  const posted = gh(["gh", "pr", "comment", String(identity.pr), "--repo", identity.repository, "--body", `Proof screenshots of \`${identity.commit.slice(0, 7)}\``, ...shots.flatMap(({ name, path }) => ["--attach", `${path}#${name}`])]);
  const comment = /^https:\/\/\S+#issuecomment-\d+$/m.exec(posted.stdout)?.[0];
  if (!comment) throw new Error(refusal(identity, posted.stderr));
  const links = await readBack(identity, directory, comment, shots.map(({ name }) => name), gh);
  const failed = shots.filter(({ name }) => !links.has(name));
  if (failed.length) throw new Error(`gh did not attach ${failed.map(({ name }) => name).join(", ")}: ${firstLine(posted.stderr) || "no link in its comment"}. Run hedge proof publish again with the same screenshots`);
  return links;
}

export async function attachProofs(home: string, identity: ProofIdentity, sources: string[], gh: Run): Promise<string[]> {
  const directory = proofDirectory(home, identity);
  const shots: Shot[] = [];
  for (const source of sources) shots.push(await screenshot(source));
  const links = new Map<string, string>();
  for (const { name } of shots) {
    const url = await publishedUrl(join(directory, name));
    if (url !== undefined) links.set(name, url);
  }
  const missing = [...new Map(shots.filter(({ name }) => !links.has(name)).map((shot) => [shot.name, shot])).values()];
  if (missing.length > attachLimit) throw new Error(`gh attaches at most ${attachLimit} files at once, and ${missing.length} of these screenshots have no link yet. Publish them in groups of ${attachLimit} or fewer`);
  if (missing.length) {
    const staging = await mkdtemp(join(tmpdir(), "hedge-attach-"));
    try {
      const files: Staged[] = [];
      for (const shot of missing) files.push(await staged(shot, staging));
      for (const [name, url] of await attach(identity, directory, files, gh)) links.set(name, url);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return shots.map(({ name }) => links.get(name)!);
}

export async function publishProof(home: string, identity: ProofIdentity, source: string, repository: string, github: GitHub, recheck = false): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new Error("Invalid asset repository");
  const { saved, bytes } = await savedScreenshot(home, identity, source);
  const receiptPath = publishedRecord(saved, repository);
  const receipt = await cached(receiptPath);
  if (typeof receipt?.url === "string") return receipt.url;
  const { login } = await github("user") as { login: string };
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Cannot identify GitHub account");
  const capabilityPath = join(home, ".local/state/hedge/proof-publish", login, `${repository.replace("/", "_")}.json`);
  let capability = recheck ? undefined : await cached(capabilityPath);
  if (capability?.policyVersion !== 1 || capability.permitted !== false) capability = undefined;
  if (!capability) {
    try {
      const repo = await github(`repos/${repository}`) as { permissions?: { push?: boolean }; default_branch?: string; private?: boolean; owner?: { login?: string } };
      capability = { policyVersion: 1, permitted: repo.permissions?.push === true && repo.private === false && repo.owner?.login?.toLowerCase() === login.toLowerCase(), defaultBranch: repo.default_branch };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      capability = { policyVersion: 1, permitted: false };
    }
    if (!capability.permitted) {
      await mkdir(dirname(capabilityPath), { recursive: true, mode: 0o700 });
      await writeFile(capabilityPath, JSON.stringify(capability), { mode: 0o600 });
    }
  }
  if (!capability.permitted) throw new Error("Asset destination denied. Choose your writable fork, or use --recheck after access changes.");
  const branch = "hedge-proof";
  try { await github(`repos/${repository}/git/ref/heads/${branch}`); }
  catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    const base = await github(`repos/${repository}/git/ref/heads/${encodeURIComponent(String(capability.defaultBranch))}`) as { object: { sha: string } };
    try { await github(`repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.object.sha }, "POST"); }
    catch (creationError) {
      if ((creationError as { status?: number }).status !== 422) throw creationError;
      await github(`repos/${repository}/git/ref/heads/${branch}`);
    }
  }
  const assetPath = `proof/${basename(saved)}`;
  let publishedCommit: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await github(`repos/${repository}/git/ref/heads/${branch}`) as { object: { sha: string } };
    try {
      let existing = await github(`repos/${repository}/contents/${assetPath}?ref=${ref.object.sha}`) as { encoding?: string; content?: string; sha?: string };
      if (existing.encoding === "none" && existing.sha && /^[0-9a-f]{40}$/.test(existing.sha)) existing = await github("repos/" + repository + "/git/blobs/" + existing.sha) as typeof existing;
      if (existing.encoding !== "base64" || typeof existing.content !== "string" || !Buffer.from(existing.content, "base64").equals(bytes)) throw new Error("Published asset differs from the saved proof");
      publishedCommit = ref.object.sha;
      break;
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
    try {
      const uploaded = await github(`repos/${repository}/contents/${assetPath}`, {
        message: "Add a proof screenshot",
        branch, content: bytes.toString("base64"),
      }, "PUT") as { commit?: { sha: string } };
      publishedCommit = uploaded.commit?.sha;
      break;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409 || status === 422) continue;
      throw error;
    }
  }
  if (!publishedCommit || !/^[0-9a-f]{40}$/.test(publishedCommit)) throw new Error("GitHub did not return the published commit; retry this saved proof");
  const url = `https://raw.githubusercontent.com/${repository}/${publishedCommit}/${assetPath}`;
  await writeFile(receiptPath, JSON.stringify({ ...identity, repository, url }) + "\n", { mode: 0o600 });
  return url;
}

export const githubRequest: GitHub = async (path, body, method = "GET") => {
  const child = Bun.spawn(["gh", "api", path, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], { stdin: body === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (body !== undefined) { child.stdin!.write(JSON.stringify(body)); child.stdin!.end(); }
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw Object.assign(new Error(`GitHub API failed for ${path}`), { status: Number(/HTTP (\d+)/.exec(error)?.[1]) });
  return JSON.parse(output);
};
