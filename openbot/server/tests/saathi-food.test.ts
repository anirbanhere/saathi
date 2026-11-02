import { expect, test } from "bun:test";
import { createVisitorFood } from "../src/saathi/food";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { ChannelStore } from "../src/channels/routes";
import type { PluginStore } from "../src/plugins/store";
import type { AuthenticatedActor } from "../src/auth/guards";

test("food provisioning isolates visitors and grants only reviewed tools to their own private Bot", async () => {
  const profiles: any[] = [];
  const grants: any[] = [];
  const connected = new Set<string>();
  const profilesStore = {
    list: async (actor: AuthenticatedActor) =>
      profiles.filter((p) => p.ownerUserId === actor.id),
    create: async (actor: AuthenticatedActor, input: any) => {
      const profile = {
        ...input,
        id: `bot-${profiles.length}`,
        ownerUserId: actor.id,
        personalAssistant: true,
      };
      profiles.push(profile);
      return profile;
    },
  } as unknown as AgentProfileStore;
  const plugins = {
    connectionsFor: async (owner: string) =>
      connected.has(owner) ? [{ serverId: "swiggy-food", revoked: false }] : [],
    refreshTools: async () => ({ tools: 5 }),
    listServers: async () => [
      {
        id: "swiggy-food",
        tools: [
          "search_restaurants",
          "update_food_cart",
          "place_food_order",
          "delete_address",
          "future_danger",
        ].map((name) => ({ name, ref: `swiggy-food/${name}` })),
      },
    ],
    grant: async (...args: any[]) => {
      grants.push(args);
    },
  } as unknown as PluginStore;
  const food = createVisitorFood({
    profiles: profilesStore,
    plugins,
    channels: {
      direct: async (actor: AuthenticatedActor, id: string) => ({
        id: `channel-${actor.id}-${id}`,
      }),
    } as unknown as ChannelStore,
    enableApprovals: async () => {},
  });
  const a: AuthenticatedActor = {
    id: `saathi-site-${"a".repeat(64)}`,
    role: "user",
    email: "a@test.invalid",
  };
  const b = { ...a, id: `saathi-site-${"b".repeat(64)}` };
  await expect(food.start({ ...a, id: "saathi-demo-test" })).rejects.toThrow(
    "Sign in",
  );
  await expect(food.enable(a)).rejects.toThrow("Connect your own");
  connected.add(a.id);
  expect((await food.status(b)).connected).toBe(false);
  const [first, concurrent] = await Promise.all([food.start(a), food.start(a)]);
  expect(first.agentId).toBe(concurrent.agentId);
  expect((await food.start(b)).agentId).not.toBe(first.agentId);
  expect((await food.enable(a)).tools).toBe(2);
  expect(grants.map((g) => g[1])).toEqual([
    "swiggy-food/search_restaurants",
    "swiggy-food/update_food_cart",
  ]);
  expect(grants.every((g) => g[2] === first.agentId && g[3] === a.id)).toBe(
    true,
  );
  expect((await food.start(a)).agentId).toBe(first.agentId);
});
