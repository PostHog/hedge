const repoLocation = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
];

/** The environment without the repository a Git hook set, so git -C <dir> works on <dir> and not on the repository that ran the hook. */
export function withoutRepoEnv(env: Record<string, string | undefined> = Bun.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !repoLocation.includes(name)));
}

/** git -C <dir> names its repository, so a hook's repository must not override it. */
export function envFor(command: string[], env: Record<string, string | undefined> = Bun.env) {
  return command[0] === "git" && command[1] === "-C" ? withoutRepoEnv(env) : env;
}
