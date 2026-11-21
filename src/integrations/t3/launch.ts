import { randomUUID } from "node:crypto";
import type { ModelRow } from "../../pack/types.ts";
import { T3Refusal, type T3Client } from "./session.ts";

export type ThreadLaunch = { title: string; prompt: string; row: ModelRow; commandId?: string };

const instances = new Map([["claude", { instanceId: "claudeAgent", effort: "effort" }], ["codex", { instanceId: "codex", effort: "reasoningEffort" }]]);
const launchTimeoutMs = 120_000;

export class UnansweredLaunch extends Error {}

type ProviderConfig = { providers?: Array<{ instanceId?: string; models?: Array<{ slug?: string; capabilities?: { optionDescriptors?: Array<{ id?: string; options?: Array<{ id?: string }> }> } }> }> };

async function offeredTier(client: Pick<T3Client, "call">, instanceId: string, row: ModelRow): Promise<string | undefined> {
  if (!row.serviceTier) return undefined;
  const config = await client.call<ProviderConfig>("server.getConfig", {}).catch(() => undefined);
  const model = config?.providers?.find((provider) => provider.instanceId === instanceId)?.models?.find((candidate) => candidate.slug === row.model);
  const tiers = model?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier")?.options?.map((option) => option.id) ?? [];
  return tiers.includes(row.serviceTier) ? row.serviceTier : undefined;
}

export async function launchScratchThread(client: Pick<T3Client, "call">, launch: ThreadLaunch): Promise<string> {
  const { projectId } = await client.call<{ projectId: string }>("projects.ensureScratch", {});
  const instance = instances.get(launch.row.provider);
  const instanceId = instance?.instanceId ?? launch.row.provider;
  const tier = await offeredTier(client, instanceId, launch.row);
  const options = [...(instance ? [{ id: instance.effort, value: launch.row.effort }] : []), ...(tier ? [{ id: "serviceTier", value: tier }] : [])];
  const { threadId } = await client.call<{ threadId: string }>("orchestration.launchThread", {
    commandId: launch.commandId ?? randomUUID(),
    projectId,
    title: launch.title,
    generateTitle: false,
    modelSelection: { instanceId, model: launch.row.model, ...(options.length ? { options } : {}) },
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: launch.prompt, attachments: [] },
  }, launchTimeoutMs).catch((error: Error) => {
    throw error instanceof T3Refusal ? error : new UnansweredLaunch(error.message);
  });
  return threadId;
}
