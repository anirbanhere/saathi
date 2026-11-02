# Swiggy Food in the private companion

Open `http://localhost:3010/settings/saathi` → **Swiggy Food**. This connects directly to Swiggy's official Food MCP endpoint, not a third-party broker.

1. Press **Connect Swiggy**. The administrator's first press installs the curated connector and registers an OAuth client. Complete phone/OTP consent only on `https://mcp.swiggy.com`. Never put the OTP in Saathi chat.
2. After consent returns to Connections, reopen Saathi settings. Press **Refresh Swiggy tools**. This reads the authenticated tool inventory; it does not place an order.
3. Press **Enable food tools on [your private assistant]**. This grants the reviewed discovery, saved-address, cart and tracking tools that Swiggy actually advertised. It does not grant address creation/deletion, order placement or payment tools. Existing grants can be managed under Admin → Plugins → Swiggy Food.
4. Start a new chat with that private assistant: “Find vegetarian dinner on Swiggy under ₹400. Ask me which saved address to use.” Then ask to prepare a cart. Review any approval requests in the companion.
5. Review the live cart and complete final checkout/payment yourself in the Swiggy app. Verify the cart there; the connected account is your real account and cart edits affect it. Saathi can subsequently track the order using its returned order ID.

The existing approval policy still applies to cart changes. Swiggy order placement and confirmation are explicitly human handovers even if those tools are later granted through Admin. This release does not provide a custom checkout UI or UPI widget. An ambiguous placement must not be retried automatically because the provider documents placement as non-idempotent.

OAuth uses encrypted, expiring state, PKCE, server-side encrypted per-user refresh tokens, JSON token exchange/rotation and session logout. The callback is exactly `http://localhost:3010/api/plugins/oauth/callback` for this installation. Swiggy may require redirect approval or account access; report authentication failures without bypassing those restrictions. Moving to another origin requires registering that exact callback again.

Disconnect under **Connections**. No credentials or addresses are shared with the public demo. The existing public gateway blocks plugin setup and calls; no Swiggy account is installed in the public demo database. The private local demo currently has automatic local login: anyone who can access that private server may act as its local owner. Do not expose that server through an unrestricted public tunnel.

Sources: [Authentication](https://mcp.swiggy.com/builders/docs/start/authenticate/), [Food ordering journey](https://mcp.swiggy.com/builders/docs/build/recipes/order-food/), [Placement contract](https://mcp.swiggy.com/builders/docs/reference/food/place_food_order/).
