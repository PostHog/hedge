import { commandsIn } from "./shell-words.ts";

const keyReason = (person: string) => `Hedge blocked this command: it changes the SSH or GPG keys on ${person}'s GitHub account, which gives lasting access. If you need it, stop and ask ${person}.`;
const tokenReason = (person: string) => "Hedge blocked this command: it signs in to GitHub, or prints or widens the GitHub token. "
  + `Use \`gh\` or \`gh auth git-credential\`, which use the token without showing it. If you need a new sign-in or scope, stop and ask ${person} to run it.`;
const extensionReason = (person: string) => "Hedge blocked this command: a gh extension is code from a GitHub repository that runs with the GitHub token. "
  + `For gh stack, ask ${person} to turn on the gh-stack workflow, which installs a pinned version with a checked digest. For any other extension, stop and ask ${person}.`;
const exposureReason = (person: string) => `Hedge blocked this command: it deletes a repository or makes code public. If you need it, stop and ask ${person}.`;
const ownerReason = (owner: string, person: string) => `Hedge blocked this command: \`${owner}\` is not one of the GitHub owners agents may use on this machine. `
  + `Use a repository of an allowed owner, or stop and ask ${person} to add \`${owner}\` to guards.owners.`;
const spellOutReason = (owner: string) => `Hedge blocked this command: the repository owner \`${owner}\` is not spelled out, so the owner check cannot read it. `
  + "A shell variable, substitution, or pattern can name any owner. Write the owner as plain text, such as `gh api repos/<owner>/<repo>/...` or `--repo <owner>/<repo>`. "
  + "In place of a loop or a function over repositories, write one command per repository, joined with `&&`.";

const commandReason = (word: string) => `Hedge blocked this command: the gh command word \`${word}\` is not spelled out, so the guard cannot tell what it runs. `
  + "A shell variable, substitution, or pattern can stand for any command. Write gh, its command group, and its action as plain text.";

export type Gh = { group: string; action: string; operands: string[]; flags: Map<string, string[]> };

const valuedFlags: Record<string, string> = {
  other: "-b --body -t --title -B --base -H --head -F --body-file -l --label -a --assignee -m --milestone -r --reviewer --json -q --jq --template -L --limit "
    + "-s --state -A --author -e --env --app -n --notes --notes-file --target -p --pattern -D --dir -O --output --search -S --branch -h --hostname --visibility -o --org --owner --repo-owner --source-owner --target-owner",
  "pr create": "-a --assignee -B --base -b --body -F --body-file -H --head -l --label -m --milestone -p --project -r --reviewer -T --template -t --title --recover",
  "pr merge": "-b --body -F --body-file -t --subject --match-head-commit -A --author-email",
  "pr review": "-b --body -F --body-file",
  "pr comment": "-b --body -F --body-file",
  "pr edit": "--add-assignee --add-label --add-project --add-reviewer --remove-assignee --remove-label --remove-project --remove-reviewer -B --base -b --body -F --body-file -m --milestone -t --title",
  "pr view": "--json -q --jq -t --template",
  "pr checks": "--json -q --jq -t --template -i --interval",
  "pr checkout": "-b --branch",
  "pr close": "-c --comment",
  "pr reopen": "-c --comment",
  "pr lock": "-r --reason",
  "pr diff": "--color",
  "pr list": "-A --author -a --assignee -B --base -H --head -l --label -L --limit -S --search -s --state --app --json -q --jq -t --template",
  "issue create": "-a --assignee -b --body -F --body-file -l --label -m --milestone -p --project -T --template -t --title --recover",
  "issue comment": "-b --body -F --body-file",
  "issue edit": "--add-assignee --add-label --add-project --remove-assignee --remove-label --remove-project -b --body -F --body-file -m --milestone -t --title",
  "issue view": "--json -q --jq -t --template",
  "issue close": "-c --comment -r --reason",
  "issue reopen": "-c --comment",
  "issue lock": "-r --reason",
  "issue develop": "-b --base -n --name --branch-repo",
  "issue list": "-A --author -a --assignee -l --label -L --limit -S --search -s --state --app --mention -m --milestone --json -q --jq -t --template",
  "repo create": "--org -d --description -h --homepage -t --team -p --template -g --gitignore -l --license -s --source -r --remote",
  "repo fork": "--org --remote-name --fork-name",
  "repo clone": "-u --upstream-remote-name",
  "repo view": "-b --branch --json -q --jq -t --template",
  "repo edit": "-d --description -h --homepage --visibility --add-topic --remove-topic --default-branch",
  "repo list": "-L --limit -l --language --topic --visibility --json -q --jq -t --template",
  "repo sync": "-b --branch -s --source",
  api: "-X --method -H --header -f --raw-field -F --field --input -q --jq -t --template --cache -p --preview --hostname",
  auth: "-h --hostname -p --git-protocol -s --scopes -r --remove-scopes -u --user",
  "gist create": "-d --desc -f --filename",
};
const repoFlags = "-R --repo";
const aliases: Record<string, string> = { new: "create", ls: "list", rm: "delete", ext: "extension", extensions: "extension", rs: "ruleset", at: "attestation", cs: "codespace" };
const accountEndpoints = /^(?:user\/(?:keys|ssh_signing_keys|gpg_keys)|authorizations)\b/;
const repositoryEndpoint = /^repos\/[^/]+\/[^/]+\/?$/;
const repositoryCreation = /^(?:user\/repos|orgs\/[^/]+\/repos|repos\/[^/]+\/[^/]+\/generate)\/?$/;
const githubUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)/;
const repoTargets = new Set(["clone", "view", "fork", "edit", "delete", "sync", "archive", "unarchive", "create", "set-default", "garden"]);
const orgShortFlag = new Set(["secret", "variable", "ruleset", "attestation", "codespace", "status"]);

function parseFlags(args: string[], table: string) {
  const valued = new Set(`${repoFlags} ${table}`.split(" "));
  const flags = new Map<string, string[]>();
  const operands: string[] = [];
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const long = arg.match(/^(--[^=]+)(?:=(.*))?$/s);
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    } else if (long) add(long[1], long[2] ?? (valued.has(long[1]) ? args[++index] ?? "" : ""));
    else if (/^-[^-]/.test(arg)) {
      for (let letter = 1; letter < arg.length; letter++) {
        const name = `-${arg[letter]}`;
        if (arg[letter + 1] === "=") add(name, arg.slice(letter + 2));
        else if (valued.has(name)) add(name, arg.slice(letter + 1) || (args[++index] ?? ""));
        else {
          add(name, "");
          continue;
        }
        break;
      }
    } else operands.push(arg);
  }
  return { flags, operands };
}

function commandWordAt(args: string[], from: number): number {
  for (let index = from; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return -1;
    if (!arg.startsWith("-")) {
      if (arg) return index;
    } else if (arg !== "-" && !arg.includes("=") && !/^-[^-]./.test(arg) && !["-h", "--help", "--version"].includes(arg)) index++;
  }
  return -1;
}

export function inOrder(args: string[]): string[] {
  if (!args[0]?.startsWith("-")) return args;
  const groupAt = commandWordAt(args, 0);
  if (groupAt < 0) return args;
  const group = args[groupAt];
  const actionAt = singleCommands.has(aliases[group] ?? group) ? -1 : commandWordAt(args, groupAt + 1);
  return [group, ...(actionAt < 0 ? [] : [args[actionAt]]), ...args.filter((_, index) => index !== groupAt && index !== actionAt)];
}

export function parseGh(given: string[]): Gh {
  const args = inOrder(given);
  const [group = "", action = ""] = parseFlags(args, valuedFlags.other).operands.map((word) => aliases[word] ?? word);
  const table = valuedFlags[`${group} ${action}`] ?? valuedFlags[group] ?? valuedFlags.other;
  const { flags, operands } = parseFlags(args, table);
  const [first = "", second = "", ...rest] = operands;
  return { group: aliases[first] ?? first, action: aliases[second] ?? second, operands: rest, flags };
}

export const values = (gh: Gh, ...names: string[]) => names.flatMap((name) => gh.flags.get(name) ?? []);
const isOn = (gh: Gh, ...names: string[]) => values(gh, ...names).some((value) => value.toLowerCase() !== "false");
const repoOwner = (value: string) => {
  const segments = value.replace(/^[a-z+]+:\/\//i, "").replace(/^git@[^:]+:/, "").split("/").filter(Boolean);
  return (segments.length >= 3 ? segments[1] : segments[0]) ?? "";
};
export const endpointOf = (gh: Gh) => gh.action.replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, "").replace(/^\//, "");

function apiFields(gh: Gh): [string, string][] {
  const fields = values(gh, "-f", "--raw-field", "-F", "--field").map((field) => field.match(/^([^=]*)=(.*)$/s));
  return fields.filter((field) => field !== null).map(([, key, value]) => [key.toLowerCase(), value.toLowerCase()]);
}

const fieldName = (key: string) => key.match(/([^[\]]*)\]?$/)?.[1] ?? key;
const readOnlyQuery = /^\s*(?:query\b|\{)/;

function publishesByGraphql(fields: [string, string][]): boolean {
  const query = fields.find(([key]) => key === "query")?.[1] ?? "";
  if (readOnlyQuery.test(query)) return false;
  return fields.some(([key, value]) => /visibility\s*:\s*\\?"?public\b/.test(value) || (fieldName(key) === "visibility" && value === "public"));
}

function apiRisk(gh: Gh, person: string): string | undefined {
  const endpoint = endpointOf(gh);
  const pairs = apiFields(gh);
  const fields = new Map(pairs);
  const input = gh.flags.has("--input");
  const method = (values(gh, "-X", "--method").at(-1) ?? (fields.size > 0 || input ? "POST" : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (accountEndpoints.test(endpoint)) return keyReason(person);
  if (endpoint === "graphql") return publishesByGraphql(pairs) ? exposureReason(person) : undefined;
  const publishes = fields.get("private") === "false" || fields.get("visibility") === "public";
  const markedPrivate = fields.get("private") === "true";
  const keepsPrivate = endpoint.startsWith("orgs/") ? markedPrivate || ["private", "internal"].includes(fields.get("visibility") ?? "") : markedPrivate;
  if (repositoryEndpoint.test(endpoint) && method === "DELETE") return exposureReason(person);
  if (repositoryCreation.test(endpoint) && method === "POST" && (input || publishes || !keepsPrivate)) return exposureReason(person);
  if (repositoryEndpoint.test(endpoint) && method === "PATCH" && (input || publishes)) return exposureReason(person);
  return undefined;
}

function exposure(gh: Gh, person: string): string | undefined {
  const { group, action } = gh;
  if ((group === "ssh-key" || group === "gpg-key") && (action === "add" || action === "delete")) return keyReason(person);
  if (group === "auth" && (action === "login" || action === "token" || action === "refresh")) return tokenReason(person);
  if (group === "auth" && action === "status" && isOn(gh, "--show-token", "-t")) return tokenReason(person);
  if (group === "extension" && (action === "install" || action === "upgrade")) return extensionReason(person);
  if (group === "repo" && action === "delete") return exposureReason(person);
  if (group === "repo" && action === "create" && isOn(gh, "--public")) return exposureReason(person);
  if (group === "repo" && action === "edit" && values(gh, "--visibility").some((value) => value.toLowerCase() === "public")) return exposureReason(person);
  if (group === "gist" && action === "create" && isOn(gh, "--public", "-p")) return exposureReason(person);
  if (group === "api") return apiRisk(gh, person);
  return undefined;
}

const destinationFields = new Set(["owner", "new_owner", "organization", "org"]);
const placeholders = new Set(["{owner}", ":owner"]);
const plainName = /^[A-Za-z0-9._-]+$/;
const plainOwner = /^[A-Za-z0-9-]+$/;

function endpointOwner(endpoint: string): string {
  const [first = "", second = "", third = "", fourth] = endpoint.replace(/\?[^/]*=.*$|#.*$/s, "").split("/").filter(Boolean);
  if (/^(?:repos|orgs|networks|enterprises)$/i.test(first)) return second;
  if (/^users$/i.test(first) && third) return second;
  if (/^user$/i.test(first) && /^(?:starred|subscriptions)$/i.test(second) && fourth !== undefined) return third;
  return /[$`*?[]/.test(first) ? first : "";
}

const searchQualifier = /(?:^|\s)"?(repo|org|user):"?([^\s"]+)/gi;
const graphqlDefault = /\$(\w+)\s*:\s*[\w![\]\s]+?=\s*"([^"]*)"/g;
const graphqlOwner = /\b(?:owner|login)\s*:\s*(?:"""([^"]*)"""|"([^"]*)"|\$(\w+))/gi;

const qualifiedOwners = (text: string) =>
  [...text.matchAll(searchQualifier)].map(([, kind, value]) => (kind.toLowerCase() === "repo" ? repoOwner(value) : value));

function graphqlOwners(gh: Gh): string[] {
  const fields = new Map(apiFields(gh).map(([key, value]) => [fieldName(key), value]));
  const query = fields.get("query") ?? "";
  const found = ["owner", "login", "org", "organization"].flatMap((name) => fields.get(name) ?? []);
  const defaults = new Map([...query.matchAll(graphqlDefault)].map(([, name, value]) => [name.toLowerCase(), value]));
  for (const [, block, literal, variable] of query.matchAll(graphqlOwner)) {
    found.push(block ?? literal ?? fields.get(variable.toLowerCase()) ?? defaults.get(variable.toLowerCase()) ?? "");
  }
  return [...found, ...[...fields.values()].flatMap(qualifiedOwners)];
}

/** The owners in the `q` of a REST search, given as a field or in the endpoint's query string. */
function restSearchOwners(gh: Gh, endpoint: string): string[] {
  const inUrl = new URLSearchParams(endpoint.match(/\?(.*)$/s)?.[1] ?? "").getAll("q");
  const inFields = apiFields(gh).filter(([key]) => fieldName(key) === "q").map(([, value]) => value);
  return [...inUrl, ...inFields].flatMap(qualifiedOwners);
}

function owners(gh: Gh, repoVariable: string | undefined): string[] {
  const listed = (...names: string[]) => values(gh, ...names).flatMap((value) => value.split(","));
  const repos = listed("-R", "--repo");
  const found = [...repos, ...(repos.length === 0 && repoVariable ? [repoVariable] : []), ...listed("--branch-repo")].map(repoOwner);
  found.push(...listed("--org", "--owner", "--repo-owner", "--source-owner", "--target-owner", ...(orgShortFlag.has(gh.group) ? ["-o"] : [])));
  const operands = gh.group === "api" ? [] : [gh.action, ...gh.operands];
  for (const operand of operands) found.push(operand.match(githubUrl)?.[1] ?? "");
  const [target] = gh.operands;
  if (gh.group === "repo" && repoTargets.has(gh.action) && target && !githubUrl.test(target) && (target.includes("/") || !plainName.test(target))) found.push(repoOwner(target));
  if (gh.group === "repo" && gh.action === "list" && target) found.push(target);
  if (gh.group === "repo" && gh.action === "sync") found.push(...values(gh, "-s", "--source").map(repoOwner));
  if (gh.group === "repo" && gh.action === "create") found.push(...values(gh, "-p", "--template").map(repoOwner));
  if (gh.group === "issue" && gh.action === "transfer" && gh.operands[1]) found.push(repoOwner(gh.operands[1]));
  if (gh.group === "label" && gh.action === "clone" && target) found.push(repoOwner(target));
  if (gh.group === "pr") found.push(...values(gh, "-H", "--head").filter((head) => head.includes(":")).map((head) => head.split(":")[0]));
  if (gh.group === "skill" && target && !githubUrl.test(target)) found.push(repoOwner(target));
  if (gh.group === "api") found.push(endpointOwner(endpointOf(gh)));
  if (gh.group === "api" && /^search\//i.test(endpointOf(gh))) found.push(...restSearchOwners(gh, endpointOf(gh)));
  if (gh.group === "api" && endpointOf(gh) !== "graphql") found.push(...apiFields(gh).filter(([key]) => destinationFields.has(fieldName(key))).map(([, value]) => value));
  if (gh.group === "api" && endpointOf(gh) === "graphql") found.push(...graphqlOwners(gh));
  if (gh.group === "search") found.push(...qualifiedOwners(gh.operands.join(" ")));
  return found.filter((owner) => owner && !placeholders.has(owner));
}


function ownerRisk(owner: string, allowed: ReadonlySet<string>, person: string): string | undefined {
  if (!plainOwner.test(owner)) return spellOutReason(owner);
  return allowed.has(owner.toLowerCase()) ? undefined : ownerReason(owner, person);
}

const brace = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
const pattern = new RegExp(`[*?[]|${brace.source}`);
const singleCommands = new Set(["api", "browse", "status"]);
export const ghGroups = new Set(["agent-task", "alias", "api", "at", "attestation", "auth", "browse", "cache", "co", "codespace", "config", "cs", "extension", "ext", "gist", "gpg-key", "issue", "label", "org", "pr", "project", "release", "repo", "rs", "ruleset", "run", "search", "secret", "skill", "ssh-key", "status", "variable", "workflow"]);

const reviewerRules = ["Bash(gh api -X POST repos/*/pulls/*/requested_reviewers *)", "Bash(gh pr edit * --add-reviewer *)"];
const trunkRules = ["Bash(gh pr comment * --body *trunk *)", "Bash(gh api *repos/*/issues/*/comments -f body=*trunk *)"];
const trunkBodies = ["/trunk merge", "/trunk cancel"];

const ruleMatcher = (rule: string) =>
  new RegExp(`^${rule.slice("Bash(".length, -1).split("*").map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`);

const reviewersEndpoint = /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/requested_reviewers$/;
const reviewerField = /^(?:team_)?reviewers\[\]=[\w.-]+$/;
const prTarget = /^(?:\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/;
const repoValue = /^[\w.-]+\/[\w.-]+$/;
const editValues: Record<string, RegExp> = { "--add-reviewer": /^[\w.@/-]+(?:,[\w.@/-]+)*$/, "--repo": repoValue, "-R": repoValue };
const commentsEndpoint = /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/;

function onlyRequestsReviewers(args: string[]): boolean {
  if (args[0] === "api") {
    const [, flag, method, endpoint, ...fields] = args;
    return flag === "-X" && method === "POST" && reviewersEndpoint.test(endpoint ?? "") && fields.length > 0
      && fields.every((field, index) => index % 2 === 0 ? field === "-f" && index + 1 < fields.length : reviewerField.test(field));
  }
  if (args[0] !== "pr" || args[1] !== "edit") return false;
  let targets = 0;
  let reviewers = 0;
  for (let index = 2; index < args.length; index++) {
    const arg = args[index];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const shape = editValues[flag];
    if (shape) {
      const value = equals > 0 ? arg.slice(equals + 1) : args[++index];
      if (value === undefined || !shape.test(value)) return false;
      if (flag === "--add-reviewer") reviewers++;
    } else if (prTarget.test(arg)) targets++;
    else return false;
  }
  return targets === 1 && reviewers > 0;
}

function onlyPostsTrunkCommand(args: string[]): boolean {
  if (args[0] === "api") {
    const rest = args[1] === "-X" && args[2] === "POST" ? args.slice(3) : args.slice(1);
    const [endpoint, flag, field, ...extra] = rest;
    return extra.length === 0 && commentsEndpoint.test(endpoint ?? "") && flag === "-f" && trunkBodies.some((body) => field === `body=${body}`);
  }
  if (args[0] !== "pr" || args[1] !== "comment") return false;
  let targets = 0;
  let bodies = 0;
  for (let index = 2; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--body") {
      if (!trunkBodies.includes(args[++index] ?? "")) return false;
      bodies++;
    } else if (arg === "--repo" || arg === "-R") {
      if (!repoValue.test(args[++index] ?? "")) return false;
    } else if (prTarget.test(arg)) targets++;
    else return false;
  }
  return targets === 1 && bodies === 1;
}

const reviewerReason = "Hedge blocked this command: it matches an allow rule for review requests, which skips the auto-mode "
  + "review, but it does more than request reviewers. Run the review request alone, in one of these shapes, and the rest "
  + "as its own call: `gh pr edit <number> [--repo <owner>/<repo>] --add-reviewer <login>[,<login>]` or "
  + "`gh api -X POST repos/<owner>/<repo>/pulls/<number>/requested_reviewers -f 'reviewers[]=<login>'` "
  + "(`team_reviewers[]=<slug>` for a team).";
const trunkReason = (person: string) => "Hedge blocked this command: it matches an allow rule for Trunk merge-queue commands, which skips the "
  + "auto-mode review, but it does more than post one bare Trunk command on one PR. Post it alone, in one of these shapes, "
  + "and run the rest as its own call: `gh pr comment <number> [--repo <owner>/<repo>] --body '/trunk merge'` or "
  + "`gh api repos/<owner>/<repo>/issues/<number>/comments -f body='/trunk merge'` (`/trunk cancel` to leave the queue). "
  + `Entering the queue still needs ${person}'s merge word in this conversation.`;

type Narrowing = { matches: RegExp; allows: (args: string[]) => boolean; reason: (person: string) => string };
const narrowings = new Map<string, Narrowing>([
  ...reviewerRules.map((rule): [string, Narrowing] => [rule, { matches: ruleMatcher(rule), allows: onlyRequestsReviewers, reason: () => reviewerReason }]),
  ...trunkRules.map((rule): [string, Narrowing] => [rule, { matches: ruleMatcher(rule), allows: onlyPostsTrunkCommand, reason: trunkReason }]),
]);

/** The Claude allow rules the gh guard can narrow, in guards.allow-rules. */
export const narrowedRules = [...narrowings.keys()];

/** Parses guards.allow-rules, one Claude allow rule per line. It throws on a rule the gh guard cannot narrow, so no listed rule goes unguarded. */
export function allowRuleList(value: unknown): Set<string> {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error("guards.allow-rules is not text");
  const rules = typeof value === "string" ? value.split("\n").map((rule) => rule.trim()).filter(Boolean) : [];
  const unknown = rules.find((rule) => !narrowings.has(rule));
  if (unknown) throw new Error(`guards.allow-rules lists ${unknown}, which the gh guard cannot narrow. It narrows only ${narrowedRules.join(", ")}`);
  return new Set(rules);
}

function allowRuleRisk(args: string[], writes: string[], rules: ReadonlySet<string>, person: string): string | undefined {
  const command = ["gh", ...args].join(" ");
  const writesFiles = writes.some((target) => target !== "/dev/null");
  for (const rule of rules) {
    const narrowing = narrowings.get(rule);
    if (narrowing?.matches.test(command) && (writesFiles || !narrowing.allows(args))) return narrowing.reason(person);
  }
  return undefined;
}

/** Parses guards.owners, a list of GitHub owners separated by commas or spaces. No list means no owner rule. */
export function ownerList(value: unknown): Set<string> | null {
  const names = typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean).map((name) => name.toLowerCase()) : [];
  return names.length ? new Set(names) : null;
}

/** Refuses gh commands that sign in, show or widen the token, change account keys, run extensions, delete or publish
 * code, name a repository whose owner is not allowed, or do more than an allow rule in `allowRules` is for.
 * `inheritedRepo` is the GH_REPO the agent's shell inherits. */
export function ghRisk(command: string, allowed: ReadonlySet<string> | null, person: string, inheritedRepo?: string, allowRules: ReadonlySet<string> = new Set()): string | undefined {
  for (const { name, args, env, bare, writes } of commandsIn(command)) {
    if ((/[$`]/.test(name) || pattern.test(bare[0] ?? "")) && ghGroups.has(parseGh(args).group)) return commandReason(name);
    const ghArgs = name === "gh" ? args : name === "xargs" && args.includes("gh") ? args.slice(args.indexOf("gh") + 1) : undefined;
    if (!ghArgs) continue;
    const braced = bare.slice(1).find((word) => brace.test(word));
    if (braced) return commandReason(braced);
    const gh = parseGh(ghArgs);
    const hidden = [gh.group, ...(singleCommands.has(gh.group) || !ghGroups.has(gh.group) ? [] : [gh.action])].find((word) => /[$`*?[{]/.test(word));
    if (hidden) return commandReason(hidden);
    const narrowed = allowRuleRisk(ghArgs, writes, allowRules, person);
    if (narrowed) return narrowed;
    if (values(gh, "--help").some((value) => !/^(?:0|f|false)$/i.test(value))) continue;
    const risk = exposure(gh, person);
    if (risk) return risk;
    if (!allowed) continue;
    for (const owner of owners(gh, env.get("GH_REPO") ?? inheritedRepo)) {
      const outside = ownerRisk(owner, allowed, person);
      if (outside) return outside;
    }
  }
  return undefined;
}
