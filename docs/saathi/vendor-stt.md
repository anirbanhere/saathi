# Gated vendor STT transport foundation

The existing exact wire fields/endpoints/header names/timeouts are now built through compileVendorSttRequest; see stt-wire-options.md for strict input and current official account/retention review. Default disablement, language/WAV/consent checks, one-attempt behavior and unverified retention eligibility are preserved. No runtime registration or live setup is added.

Two internal factories implement the existing `SpeechToTextProvider` port: `createSarvamStt` and `createElevenLabsStt` in `vendor-stt.ts`. They are disabled by default. No public route, upload, speech-role registry binding, private profile, vendor key or live request is added by this slice. Existing diagnostic `adapter_missing` still describes the missing runtime binding, even though transport code is now present. Public speech remains off.

This advances provider interchangeability; it does not complete the voice product. Owner-scoped media, durable consent, retention/deletion, speech-attempt budgets, response policies, actual TTS and consented language/critical-field evaluation remain required before exposing voice. A literal call consent flag is neither a user identity nor a durable permission record.

## Boundary and inputs

Factory options select an explicit reviewed model, optional key, allowed languages, timeout, transport and `allowLiveRequests`. The latter defaults to false; providing a key alone cannot enable requests. Keys are passed only to the appropriate fixed HTTPS endpoint/header and never become transcript/source metadata. No user URL, webhook destination, local filename or arbitrary model endpoint is accepted. Caller-supplied audio is copied before validation/request construction.

`inspectPcmWav` validates finite PCM16 RIFF/WAVE chunks, alignment, sample rate, channels, byte length and duration, including padded metadata chunks and subarray offsets. It supports one/two channels and the explicitly checked sample rates. It is not a general decoder, ASR detector or transcoder. The shared parser caps 2MB/60s; these initial synchronous vendor ports accept100ms–29s. OGG/Opus/MP3, longer batch audio and general media ingestion remain later work.

The direct port requires valid WAV bytes, declared WAV MIME, explicit consent and an abort signal. Allowed language defaults are en-IN/hi-IN/ta-IN. ml-IN/kn-IN can be explicitly selected for transport tests, but successful mapping is not speech-quality evidence. Missing/unsupported provider language is rejected rather than silently replaced with the user's hint. Mixed-script returned text is preserved apart from outer whitespace.

## Official REST contracts

Verified against primary references on29 October2026:

- [Sarvam STT reference](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe): multipart `POST /speech-to-text`, `api-subscription-key`, file/model/language fields and returned transcript/dominant language. The factory supports explicit `saaras:v3`/`saaras:v4`. The page's model list mentions v4 modes while its mode field describes v3 only; this implementation sends `transcribe` for v3 and omits mode for v4's default. No translation, keyterms, diarization or timestamps are requested. No Sarvam retention-control parameter has been verified; passing that option is rejected.
- [ElevenLabs STT reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert?explorer=true): multipart `POST /v1/speech-to-text`, `xi-api-key`, explicit `scribe_v2`, ISO language hint and text/language response. The factory disables webhooks, multichannel processing, diarization, audio events and timestamps; it adds no editing/entity/keyterm features. `providerLogging` defaults to deny, requesting `enable_logging=false`. The reference restricts that mode to enterprise accounts. A rejection fails without re-enabling logging; explicit allow sends true. This request preference is not an independently verified deletion guarantee.

Language probability is a language-label measure, not transcription accuracy. Normalized transcript confidence therefore remains null, with warnings to confirm names/dates/amounts and review provider processing terms. `source.mode=live` identifies the vendor transport contract and `source.model` its requested model; neither attests actual language accuracy or the provider's internal model. Mocked HTTP tests are not live-service evidence.

## Transport and failure behavior

Each call has one attempt, redirect rejection, bounded JSON (128KB), strict transcript normalization, deadline and parent cancellation. Streaming body readers are cancelled on abort. Timeout/cancel suppress late results even if an injected transport ignores its signal; cancellation cannot guarantee a remote process or billing reversal. Error bodies, raw HTTP exceptions, keys and source audio are not logged/returned. Authorization/retention-eligibility and busy failures do not retry or fall back to another provider/model/logging mode.

The factories do not load environment files or mutate database state. They are not a public speech runner: admission/billing ledgers and owned-media permission checks must wrap them before integration. A per-request duration cap does not impose an account spending limit. No live paid speech probe is authorized by these instructions.

## Verification and next work

Use `bun run saathi:self-hosted:test` or, from `openbot`, `bun test self-hosted`, server types and the unchanged frozen Linux test-type gate. Tests use generated tones and mocked responses only. They cover exact multipart/header isolation, language mapping without guessed hints, null confidence, disabled/missing credentials/invalid audio/consent, invalid/oversized response, redacted failures, deadlines, pre/in-flight cancellation and cancelled stream readers. Existing fixture speech contracts remain synthetic tone/preset lookup.

Next: Sarvam/ElevenLabs TTS ports and reviewed output policies, then the owner-scoped media/consent/retention and budget path. Genuine en/hi/ta/code-switching evaluation and ml/kn acceptance require separately authorized provider setup and consented recordings. Do not label the PRD speech requirements complete from these wire-format tests.
