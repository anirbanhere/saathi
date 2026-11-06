# Stable Saathi decisions

- This fork uses OpenDuet/OpenBot/CopilotKit as a candidate product foundation. The Python Saathi reference and deployed Home Agents site remain separate; no data/runtime migration has happened.
- First priority is everyday tasks and the dental appointment vertical. Kitchen and inventory are separate specializations. Text-language instructions are not measured Indic speech capability.
- Initial inference profile uses OpenRouter free models; models remain replaceable. No paid fallback is configured. Key guardrails must control spend even if upstream UI settings change.
- CopilotKit Intelligence is currently a required upstream thread/memory service. It is a separate credential/data boundary from model inference; optional telemetry is disabled in the Saathi example.
- Public WhatsApp, real account actions, purchases/payments and production hosting require their own access, policy, identity and operational decisions. No upstream feature claim proves Saathi-specific readiness.
