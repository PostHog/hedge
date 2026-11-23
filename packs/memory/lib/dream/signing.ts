import type { Result } from "../../../hub/lib/coder.ts";

export const signingTimedOut = ({ code, stderr }: Result) => code !== 0 && /timed out/i.test(stderr);

const done: Result = { code: 0, stdout: "", stderr: "" };

export async function onceMoreOnSigningTimeout(run: () => Promise<Result>, cleanUp: () => Promise<Result> = async () => done): Promise<Result> {
  const first = await run();
  if (!signingTimedOut(first) || (await cleanUp()).code !== 0) return first;
  return run();
}
