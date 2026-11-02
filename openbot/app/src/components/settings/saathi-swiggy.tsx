import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";

type Tool = { name: string; ref: string; grantedTo: string[] };
type Server = { id: string; tools: Tool[]; lastError: string | null };
type Bot = { id: string; name: string; mine: boolean; visibility: string };
const foodTools = new Set([
  "get_addresses",
  "recommend_address",
  "search_restaurants",
  "get_restaurant_menu",
  "search_menu",
  "fetch_food_coupons",
  "get_food_cart",
  "get_food_orders",
  "get_food_order_details",
  "track_food_order",
  "get_food_delivery_status",
  "update_food_cart",
  "flush_food_cart",
  "apply_food_coupon",
]);

export function SaathiSwiggy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const data = useQuery({
    queryKey: ["saathi", "swiggy"],
    queryFn: async () => {
      const [plugins, accounts, bots] = await Promise.all([
        client("/api/plugins").then((r) => r.json()) as Promise<{
          servers: Server[];
        }>,
        client("/api/plugins/connections").then((r) => r.json()) as Promise<{
          connections: { serverId: string; revoked: boolean; holder: string }[];
        }>,
        client("/api/agents").then((r) => r.json()) as Promise<{
          agents: Bot[];
        }>,
      ]);
      return {
        server: plugins.servers.find((s) => s.id === "swiggy-food"),
        connected: accounts.connections.some(
          (c) =>
            c.serverId === "swiggy-food" && c.holder === "person" && !c.revoked,
        ),
        bots: bots.agents.filter((b) => b.mine && b.visibility === "private"),
      };
    },
  });
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await data.refetch();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Swiggy setup failed. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  const state = data.data;
  return (
    <PageSection title="Swiggy Food">
      <p className="text-sm text-muted-foreground">
        Connect your own Swiggy account to find restaurants, prepare a cart and
        track orders. Sign in and enter OTPs only on Swiggy’s page. Your saved
        addresses and cart are shared with your selected model when you use
        these tools.
      </p>
      {data.isPending ? (
        <p role="status">Checking Swiggy connection…</p>
      ) : data.isError ? (
        <p role="alert">
          Could not load Swiggy setup.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void data.refetch()}
          >
            Retry
          </button>
        </p>
      ) : (
        <>
          <p className="text-sm">
            {state?.connected
              ? "Your Swiggy account is connected."
              : "Swiggy is not connected."}{" "}
            Checkout and payment stay in the Swiggy app.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (!state?.server)
                    await client("/api/plugins/servers", {
                      method: "POST",
                      body: { key: "swiggy-food" },
                    });
                  const result = (await (
                    await client("/api/plugins/servers/swiggy-food/connect", {
                      method: "POST",
                    })
                  ).json()) as { authorizationUrl: string };
                  const url = new URL(result.authorizationUrl);
                  if (
                    url.origin !== "https://mcp.swiggy.com" ||
                    url.pathname !== "/auth/authorize"
                  )
                    throw new Error(
                      "Swiggy returned an unexpected sign-in address.",
                    );
                  window.location.assign(url.href);
                })
              }
            >
              {state?.connected ? "Reconnect Swiggy" : "Connect Swiggy"}
            </Button>
            {state?.connected && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const result = (await (
                      await client("/api/plugins/servers/swiggy-food/refresh", {
                        method: "POST",
                      })
                    ).json()) as { tools: number };
                    setNotice(
                      `Swiggy returned ${result.tools} tools. Enable food tools on your private assistant below.`,
                    );
                  })
                }
              >
                Refresh Swiggy tools
              </Button>
            )}
          </div>
          {state?.connected &&
            state.server &&
            state.bots.map((bot) => {
              const tools = state.server!.tools.filter((t) =>
                foodTools.has(t.name),
              );
              const enabled =
                tools.length > 0 &&
                tools.every((t) => t.grantedTo.includes(bot.id));
              return (
                <div
                  key={bot.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span>
                    {bot.name}:{" "}
                    {enabled ? "food tools enabled" : "food tools not enabled"}
                  </span>
                  <Button
                    variant="outline"
                    disabled={busy || enabled || tools.length === 0}
                    onClick={() =>
                      void perform(async () => {
                        for (const tool of tools)
                          await client("/api/plugins/grants", {
                            method: "POST",
                            body: {
                              kind: "mcp",
                              ref: tool.ref,
                              agentId: bot.id,
                            },
                          });
                        setNotice(
                          `Food tools enabled on ${bot.name}. Open a new chat and ask to find food on Swiggy.`,
                        );
                      })
                    }
                  >
                    Enable food tools on {bot.name}
                  </Button>
                </div>
              );
            })}
          <p className="text-sm text-muted-foreground">
            Cart changes use Saathi’s approval controls. Final checkout is a
            human handover; this integration does not place or pay for orders.
            Setup and tool access changes require an administrator. Manage or
            disconnect your account in{" "}
            <a className="underline" href="/connections">
              Connections
            </a>
            .
          </p>
          {state?.server?.lastError && (
            <p className="text-sm text-muted-foreground">
              Swiggy tools need attention. Connect your account, then refresh
              the tools.
            </p>
          )}
        </>
      )}
      {busy && <p role="status">Updating Swiggy setup…</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </PageSection>
  );
}
