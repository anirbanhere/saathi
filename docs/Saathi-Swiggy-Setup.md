# Swiggy Food in the private companion

## Live site: one connection per signed-in visitor

Open [Swiggy on the live demo](https://saathi-live-demo.glassyibex32.chatgpt.site/food). Sign in with ChatGPT, then choose **Connect Swiggy** and complete the Swiggy phone/OTP flow. Return to the food page and choose **Enable food tools & open private chat**. Each signed-in visitor has their own private assistant, channel, approval inbox and encrypted Swiggy connection. Disconnect on the same food page. Checkout remains in the Swiggy app.

The Site remains public. Anonymous visitors retain the shared general demo but cannot access the personal Food APIs. Sites identity is forwarded only by the authenticated server bridge; browser-supplied impersonation headers are discarded. The local backend hashes the Site identity into a separate regular user with a synthetic email, never an administrator or the owner's localhost account. Private records continue to use existing server-side ownership checks. The host's demo model account funds these runs; its key stays on the PC. This is explicit demo model sharing, not sharing of Swiggy accounts or private chats. Aggregate demo rate limits still apply. Host PC/Docker/tunnel uptime is still required.

The hosted OAuth redirect is `https://saathi-live-demo.glassyibex32.chatgpt.site/api/plugins/oauth/callback`; the local connector and hosted connector register distinct clients in their separate databases. Live OTP consent, cart editing and tracking require the visitor's real Swiggy sign-in and remain unverified until then.

## Local private companion

Open `http://localhost:3010/settings/saathi` → **Swiggy Food**. This connects directly to Swiggy's official Food MCP endpoint, not a third-party broker.

1. Press **Connect Swiggy**. The administrator's first press installs the curated connector and registers an OAuth client. Complete phone/OTP consent only on `https://mcp.swiggy.com`. Never put the OTP in Saathi chat.
2. After consent returns to Connections, reopen Saathi settings. Press **Refresh Swiggy tools**. This reads the authenticated tool inventory; it does not place an order.
3. Press **Enable food tools on [your private assistant]**. This grants the reviewed discovery, saved-address, cart and tracking tools that Swiggy actually advertised. It does not grant address creation/deletion, order placement or payment tools. Existing grants can be managed under Admin → Plugins → Swiggy Food.
4. Start a new chat with that private assistant: “Find vegetarian dinner on Swiggy under ₹400. Ask me which saved address to use.” Then ask to prepare a cart. Review any approval requests in the companion.
5. Review the live cart and complete final checkout/payment yourself in the Swiggy app. Verify the cart there; the connected account is your real account and cart edits affect it. Saathi can subsequently track the order using its returned order ID.

The existing approval policy still applies to cart changes. Swiggy order placement and confirmation are explicitly human handovers even if those tools are later granted through Admin. This release does not provide a custom checkout UI or UPI widget. An ambiguous placement must not be retried automatically because the provider documents placement as non-idempotent.

OAuth uses encrypted, expiring state, PKCE, server-side encrypted per-user refresh tokens, JSON token exchange/rotation and session logout. The callback is exactly `http://localhost:3010/api/plugins/oauth/callback` for this installation. Swiggy may require redirect approval or account access; report authentication failures without bypassing those restrictions. Moving to another origin requires registering that exact callback again.

Disconnect the local account under **Connections**. Localhost accounts and credentials are not copied to the hosted demo. On the hosted demo, the gateway permits only the narrow personal Food endpoints after Sites sign-in; general plugin administration and model-key management remain blocked. The private local demo currently has automatic local login: anyone who can access that private server may act as its local owner. Do not expose that server through an unrestricted public tunnel.

Sources: [Authentication](https://mcp.swiggy.com/builders/docs/start/authenticate/), [Food ordering journey](https://mcp.swiggy.com/builders/docs/build/recipes/order-food/), [Placement contract](https://mcp.swiggy.com/builders/docs/reference/food/place_food_order/).
