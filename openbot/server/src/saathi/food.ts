import type { AgentProfileStore } from "../agents/profile-store";
import type { AuthenticatedActor } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";
import type { PluginStore } from "../plugins/store";
import { catalogueEntry } from "../plugins/catalogue";
import { SaathiConfigurationError } from "./models";
import { SAATHI_PROMPT } from "./service";

const TITLE = "Your private Swiggy assistant";
const CART_TOOLS = new Set([
  "update_food_cart",
  "flush_food_cart",
  "apply_food_coupon",
]);
export function createVisitorFood(deps: {
  profiles: AgentProfileStore;
  channels: ChannelStore;
  plugins: PluginStore;
  enableApprovals(owner: string): Promise<void>;
}) {
  const pending = new Map<
    string,
    Promise<{ channelId: string; agentId: string }>
  >();
  function owner(actor: AuthenticatedActor) {
    if (!/^saathi-site-[a-f0-9]{64}$/.test(actor.id))
      throw new SaathiConfigurationError(
        "Sign in on the live site to use your personal Swiggy connection.",
      );
  }
  async function status(actor: AuthenticatedActor) {
    owner(actor);
    const connections = await deps.plugins.connectionsFor(actor.id);
    return {
      connected: connections.some(
        (c) => c.serverId === "swiggy-food" && !c.revoked,
      ),
    };
  }
  async function start(actor: AuthenticatedActor) {
    owner(actor);
    if (pending.has(actor.id)) return pending.get(actor.id)!;
    const work = (async () => {
      let profile = (await deps.profiles.list(actor)).find(
        (p) =>
          p.ownerUserId === actor.id &&
          p.visibility === "private" &&
          p.title === TITLE &&
          p.personalAssistant,
      );
      if (!profile)
        profile = await deps.profiles.create(actor, {
          name: "Saathi",
          title: TITLE,
          roleDescription: SAATHI_PROMPT,
          systemPrompt: SAATHI_PROMPT,
          visibility: "private",
          runLocally: true,
        });
      await deps.enableApprovals(actor.id);
      const channel = await deps.channels.direct(actor, profile.id);
      return { channelId: channel.id, agentId: profile.id };
    })();
    pending.set(actor.id, work);
    try {
      return await work;
    } finally {
      pending.delete(actor.id);
    }
  }
  return {
    status,
    start,
    async enable(actor: AuthenticatedActor) {
      if (!(await status(actor)).connected)
        throw new SaathiConfigurationError(
          "Connect your own Swiggy account first.",
        );
      const bot = await start(actor);
      await deps.plugins.refreshTools("swiggy-food", actor.id);
      const server = (await deps.plugins.listServers()).find(
        (s) => s.id === "swiggy-food",
      );
      const reads = catalogueEntry("swiggy-food")?.readTools ?? [];
      const tools =
        server?.tools.filter(
          (t) => reads.includes(t.name) || CART_TOOLS.has(t.name),
        ) ?? [];
      if (tools.length === 0)
        throw new SaathiConfigurationError(
          "Swiggy did not return usable food tools. Reconnect and try again.",
        );
      // No user-supplied Bot IDs or tool refs: only this visitor's private Bot and reviewed tools.
      for (const tool of tools)
        await deps.plugins.grant("mcp", tool.ref, bot.agentId, actor.id);
      return { ...bot, tools: tools.length };
    },
  };
}
export type VisitorFood = ReturnType<typeof createVisitorFood>;
