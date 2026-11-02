# Calling setup for the India pilot

## Available now

The private companion has a **Phone calls** section at `http://localhost:3010/settings/saathi`. With `SAATHI_CALLS_SIMULATOR=true`, it can preview an outgoing request, require approval of that exact preview, simulate an incoming call, answer, stop AI control, and end the simulation. Sessions are stored privately in PostgreSQL; expired approvals and concurrent approval reuse are refused. Restarting the server preserves history. Nothing in this simulator sends audio, dials a telephone, purchases a number or incurs carrier charges.

The public shared demo cannot use these APIs. Do not enable personal calling there. The simulator flag is set only in the local private Docker override. To disable it, remove the flag and restart the private web service. Migration `0070_saathi_calls` is required before enabling simulation.

## Provider setup to obtain

Exotel is the initial India-focused candidate. Create your own account through its [official dashboard](https://my.exotel.com/) and ask for an Indian ExoPhone with the intended inbound and outbound use enabled. Confirm actual number availability, account verification, permitted calling use, pricing, and destination coverage with Exotel. Do not purchase a number on the assumption that it supports both directions or the desired voice integration.

Ask Exotel to enable bidirectional **Voicebot / AgentStream**, rather than receive-only Stream. Its [protocol](https://developer.exotel.com/docs/agentstream/websocket-protocol) transports linear16 PCM over an authenticated WebSocket, with clear events for interruptions. Obtain the API key, API token and account SID from your dashboard. Enter credentials only through the future private provider setup or server-side secret configuration; do not paste them into chat or commit them.

For simple outbound AI calls, Exotel documents [Connect Voice AI](https://developer.exotel.com/docs/agentstream/connect-voice-ai). It explicitly does not include agent transfer or a multi-step IVR. For live transfer, confirm an appropriate Flow or Programmable Voice arrangement with Exotel; do not treat stopping the simulator's AI as a real telephone transfer. Inbound routing also needs the assigned number attached to the provider's approved flow. A local development server needs a stable, authenticated public ingress for real carrier events and media.

## Remaining implementation before real calling

The Exotel dialing/webhook/media adapter, streaming speech integration and real owner voice handover are not implemented in this first slice. They must be connected and tested against the provisioned account before `liveCalling` can become true. No environment flag currently enables real dialing. The existing browser voice feature is not a PSTN media bridge.

Implement provider-authenticated event ingestion and call-bound media sessions; bind the provider number and each call to a private owner. For speech, configure a validated real-time speech service or streaming STT/TTS, and verify required Indian languages, interruption and audio formats. The Muse text API key must not be presented as supplying telephony or speech. Confirm a safe human-transfer or explicitly labelled callback fallback.

Before a real pilot, verify an approved outgoing test call and a consenting incoming test caller, cost limits, no-answer/voicemail, disconnect reconciliation, recording-off behavior, takeover, spoofed caller-ID isolation, and denial of public-demo access. Do not start real calls or spend on provisioning without the owner's specific authorization. Swiggy remains deferred.
