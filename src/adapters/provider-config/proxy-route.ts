import type { Plan, Provider } from "../../pack/types.ts";
import { get, keyPath, overlaps, same, samePath, type Document } from "./fields.ts";

export const proxyUrl = "http://127.0.0.1:8317";
export const keyHelper = 'cat "$HOME/.config/hedge/cli-proxy.key"';
export const codexProvider = "hedge-proxy";
export const codexProviderTable = { name: "Hedge CLI proxy", base_url: `${proxyUrl}/v1`, wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", keyHelper] } };

type Route = { agent: string; fields: Array<{ path: string[]; value: unknown }>; beside(document: Document, leaving: string[][]): string[][] };

const baseUrl = ["env", "ANTHROPIC_BASE_URL"];
const codexTable = ["model_providers", codexProvider];
const claudeCredentials = [["apiKeyHelper"], ["env", "ANTHROPIC_AUTH_TOKEN"], ["env", "ANTHROPIC_API_KEY"]];
const leaves = (leaving: string[][], path: string[]) => leaving.some((item) => samePath(item, path));

export const proxyRoute: Partial<Record<Provider, Route>> = {
  claude: {
    agent: "Claude Code",
    fields: [{ path: baseUrl, value: proxyUrl }, { path: ["apiKeyHelper"], value: keyHelper }],
    beside: (document, leaving) => (leaves(leaving, baseUrl) ? claudeCredentials.filter((path) => get(document, path) !== undefined) : []),
  },
  codex: {
    agent: "Codex",
    fields: [{ path: ["model_provider"], value: codexProvider }, { path: codexTable, value: codexProviderTable }],
    beside: (document, leaving) => (leaves(leaving, codexTable) && get(document, ["model_provider"]) === codexProvider ? [["model_provider"]] : []),
  },
};

type Entry = Plan["config"][number];

export function wholeRoutes(config: Entry[], dropped: Entry[]): Pick<Plan, "config" | "dropped"> {
  const leaving = Object.entries(proxyRoute).flatMap(([provider, route]) => {
    const onRoute = (entry: Entry) => entry.provider === provider && route.fields.some((item) => samePath(item.path, keyPath(entry.key)) && same(item.value, entry.value));
    const parts = config.filter(onRoute);
    const other = config.find((entry) => entry.provider === provider && !onRoute(entry) && route.fields.some((item) => overlaps(item.path, keyPath(entry.key))));
    const gone = dropped.find(onRoute);
    if (!parts.length || (!other && !gone)) return [];
    const reason = other ? `${other.pack === "profile" ? "your profile" : `the ${other.pack} pack`} sets ${provider}:${other.key}, so Hedge's ${route.agent} proxy route leaves as one unit` : `${provider}:${gone!.key} left the plan, so Hedge's ${route.agent} proxy route leaves as one unit`;
    return parts.map((entry) => ({ entry, reason }));
  });
  return { config: config.filter((entry) => !leaving.some((item) => item.entry === entry)), dropped: leaving.map(({ entry, reason }) => ({ pack: entry.pack, item: `config ${entry.provider}:${entry.key}`, reason })) };
}

const hubOnly: Partial<Record<Provider, Array<{ path: string[]; value?: unknown; name: string }>>> = {
  claude: [
    { path: baseUrl, value: proxyUrl, name: `env.ANTHROPIC_BASE_URL = ${proxyUrl}` },
    { path: ["apiKeyHelper"], value: keyHelper, name: `apiKeyHelper = ${keyHelper}` },
  ],
  codex: [
    { path: ["model_provider"], value: codexProvider, name: `model_provider = "${codexProvider}"` },
    { path: codexTable, name: `the ${codexProvider} provider table` },
  ],
};

export function hubOnlySetting(provider: Provider, key: string, value: unknown) {
  const reserved = hubOnly[provider];
  if (!reserved) return undefined;
  const path = keyPath(key);
  return reserved.find((item) => {
    if (path.length > item.path.length) return item.value === undefined && samePath(path.slice(0, item.path.length), item.path);
    if (!samePath(item.path.slice(0, path.length), path)) return false;
    const held = get({ value }, ["value", ...item.path.slice(path.length)]);
    return item.value === undefined ? held !== undefined : same(held, item.value);
  })?.name;
}
