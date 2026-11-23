import type { Result } from "../../../hub/lib/coder.ts";

export const signingTimedOut = ({ code, stderr }: Result) => code !== 0 && /timed out/i.test(stderr);

export async function onceMoreOnSigningTimeout(run: () => Promise<Result>, cleanUp: () => Promise<unknown> = async () => undefined): Promise<Result> {
  const first = await run();
  if (!signingTimedOut(first)) return first;
  await cleanUp();
  return run();
}
