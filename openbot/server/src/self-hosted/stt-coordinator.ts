import { LocalError } from "./errors";
import type { ProviderRoles } from "./roles";
import {
  createFixtureSttProvider,
  type Transcript,
  withSpeechDeadline,
} from "./speech";
import type { SttAdmissions } from "./stt-admission";
import { validateFixtureOutcome } from "./stt-outcome";

type Options = {
  /** Trusted test injection, never populated from a request/model/config credential. */
  fixtureProvider?: typeof createFixtureSttProvider;
  now?: () => number;
};
type Job = { controller: AbortController; done: Promise<void> };

/** In-process/keyless fixture execution only; no public route or live adapter registration. */
export class FixtureSttCoordinator {
  private active = new Map<string, Job>();
  private acknowledgementFailed = false;
  private stopping = false;
  private now: () => number;
  private fixtureProvider: typeof createFixtureSttProvider;
  constructor(
    private admissions: SttAdmissions,
    private currentRoles: () => ProviderRoles,
    options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fixtureProvider = options.fixtureProvider ?? createFixtureSttProvider;
  }
  private key(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  /** Terminal per-instance stop. Signalling is not proof that a worker has ended. */
  stop() {
    if (!this.stopping) {
      this.stopping = true;
      for (const job of this.active.values()) job.controller.abort();
    }
    return {
      stopping: true as const,
      pendingWorkers: this.active.size,
      acknowledgementFailed: this.acknowledgementFailed,
    };
  }
  cancel(owner: string, id: string) {
    // Durable ownership/cancellation succeeds before another worker can be signalled.
    const admission = this.admissions.cancel(owner, id);
    this.active.get(this.key(owner, id))?.controller.abort();
    return admission;
  }
  /** Trusted admission guard; also surfaces late acknowledgement failure before reservation. */
  assertAccepting() {
    if (this.acknowledgementFailed)
      throw new LocalError(
        "Fixture acknowledgement failed; exclusive recovery is required.",
        503,
      );
    if (this.stopping)
      throw new LocalError(
        "Fixture execution is stopping; no new work was claimed.",
        503,
      );
  }
  async run(owner: string, id: string, parent?: AbortSignal) {
    this.assertAccepting();
    if (parent?.aborted) return this.cancel(owner, id);
    const role = this.currentRoles().stt;
    // A dynamic server-role getter may itself initiate shutdown.
    this.assertAccepting();
    const claim = this.admissions.claim(owner, id, role);
    if (!claim.fresh) return claim.admission;
    const key = this.key(owner, id),
      controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active.set(key, { controller, done });
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    let actual: Promise<Transcript> | undefined,
      finished = false;
    let outcome: ReturnType<typeof validateFixtureOutcome>["outcome"];
    try {
      const remaining = Math.min(
        claim.admission.role.timeoutMs,
        (claim.admission.claimDeadline ?? 0) - this.now(),
      );
      if (remaining <= 0) throw new LocalError("Fixture deadline passed.", 504);
      const transcript = await withSpeechDeadline(
        remaining,
        (signal) => {
          // A queued microtask must not invoke after durable cancel/revocation/expiry.
          if (this.admissions.get(owner, id).state !== "claimed")
            throw new LocalError("Fixture request stopped.", 408);
          if (this.now() >= (claim.admission.claimDeadline ?? 0))
            throw new LocalError("Fixture deadline passed.", 504);
          actual = Promise.resolve().then(() => {
            if (signal.aborted)
              throw new LocalError("Fixture request stopped.", 408);
            return this.fixtureProvider(
              claim.admission.role.provider,
            ).transcribe({
              audio: claim.audio,
              mimeType: "audio/wav",
              languageHint: claim.admission.languageHint as
                | "en-IN"
                | "hi-IN"
                | "ta-IN"
                | null,
              consentToProcess: true,
              signal,
            });
          });
          // Deadline/abort can win the bounded race while this invocation still runs.
          actual.then(
            () => {
              finished = true;
            },
            () => {
              finished = true;
            },
          );
          return actual;
        },
        controller.signal,
      );
      outcome = validateFixtureOutcome(
        { status: "completed", transcript },
        claim.admission.role,
      ).outcome;
      if (JSON.stringify(outcome).length > 20000)
        throw new LocalError(
          "Fixture outcome exceeds its retention budget.",
          502,
        );
    } catch (error) {
      outcome = {
        status: "failed",
        code:
          error instanceof LocalError && error.status === 504
            ? "timeout"
            : controller.signal.aborted ||
                (error instanceof LocalError && error.status === 408)
              ? "aborted"
              : "provider_failed",
      };
    } finally {
      parent?.removeEventListener("abort", abort);
    }
    const acknowledge = () => {
      try {
        // A stop can arrive after the bounded race fulfilled but before validation
        // or settlement. It still cannot turn late success into retained text.
        if (this.stopping && outcome.status === "completed")
          outcome = { status: "failed", code: "aborted" };
        return this.admissions.settle(owner, id, claim.executorToken, outcome);
      } catch {
        this.acknowledgementFailed = true;
        throw new LocalError(
          "Fixture acknowledgement failed; exclusive recovery is required.",
          503,
        );
      } finally {
        this.active.delete(key);
        finish();
      }
    };
    if (actual && !finished) {
      // Keep the durable owner slot until the real invocation acknowledges. Do not
      // retain its late transcript or let an abort-ignoring failure go unhandled.
      void actual.then(acknowledge, acknowledge).catch(() => {});
      return this.admissions.get(owner, id);
    }
    return acknowledge();
  }
  /** Trusted shutdown/test hook. May wait indefinitely for an abort-ignoring adapter. */
  async drain() {
    await Promise.all([...this.active.values()].map((job) => job.done));
    if (this.acknowledgementFailed)
      throw new LocalError(
        "Fixture acknowledgement failed; exclusive recovery is required.",
        503,
      );
  }
}
