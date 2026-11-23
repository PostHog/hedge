export const packFlows: Record<string, string[]> = {
  "pull-requests": ["Your request", "Tests, then the fix", "Proof and a second-model review", "QA swarm", "Draft pull request"],
  orchestration: ["A large change", "Map of tickets", "Conductor thread", "One subthread per ticket", "Draft pull requests"],
  memory: ["Agents learn, or you save a note", "Your private memory repo", "Every box pulls it", "Your next prompt recalls it"],
  guards: ["Agent's shell command", "Guard hook", "The command runs or stops"],
  slack: ["Your Slack message or reaction", "Your Slack app", "T3 thread", "Link in Slack"],
  "incident-io": ["Agent watching your change", "Tripwire fires", "Your incident.io alert route", "Your phone rings"],
  "mcp-gateway": ["Agent on any machine", "Tunnel to the hub", "MCP gateway", "Your MCP servers"],
  security: ["Agent on any machine", "MCP gateway on the hub", "Read-only Wiz sign-in", "Your Wiz findings"],
  hub: ["A thread hits a usage limit", "The hub asks the provider", "The provider answers", "The thread continues"],
};
