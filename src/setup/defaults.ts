import type { SourceRef } from "../pack/types.ts";

export const engineRepo = "PostHog/hedge";

export const ownDevboxPacks = ["posthog"];

export const needsHubPacks = ["hub", "mcp-gateway", "security"];

export const makesOwnDevbox = (packs: string[]) => packs.some((pack) => ownDevboxPacks.includes(pack));

export const defaultSources: SourceRef[] = [
  { name: "agent-skills", repo: "Silthus/agent-skills", ref: "f699760221f6f7dc17495590283977aefda2ecbc" },
  { name: "mattpocock-skills", repo: "mattpocock/skills", ref: "4ae2317ddb22b046e26455e4f9c9b3aaaf62212d" },
];

const retiredDefaultRefs: Record<string, string[]> = {
  "agent-skills": [
    "997eb88e03cb322941f387ab577207335d77c414",
    "6595e9ffecd03afdede25947d8d09361026cda92",
  ],
};

export const followCurrentDefaults = (sources: SourceRef[]) =>
  sources.map((source) => {
    const current = defaultSources.find((item) => item.name === source.name && item.repo === source.repo);
    return current && retiredDefaultRefs[source.name]?.includes(source.ref) ? { ...source, ref: current.ref } : source;
  });
