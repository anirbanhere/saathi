import { LocalError } from "./errors";
import type { ProviderRoles } from "./roles";
import type { SelfHostedStore } from "./store";
import { assertFixtureSttRole } from "./stt-admission";
import { FixtureSttCoordinator } from "./stt-coordinator";

/** Trusted local fixture runtime. No vendor factory, credential or public grant is accepted. */
export class LocalFixtureSpeechRuntime {
  private coordinator: FixtureSttCoordinator;
  private stopping = false;
  private failed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private store: SelfHostedStore,
    private roles: () => ProviderRoles,
    // Trusted test injection only. The application entry always uses built-in fixtures.
    options: ConstructorParameters<typeof FixtureSttCoordinator>[2] = {},
  ) {
    assertFixtureSttRole(roles().stt);
    this.coordinator = new FixtureSttCoordinator(
      store.sttAdmissions,
      roles,
      options,
    );
  }
  private accepting() {
    this.coordinator.assertAccepting();
    if (this.stopping || this.failed)
      throw new LocalError(
        "Local fixture execution is unavailable; no new reservation was made.",
        503,
      );
  }
  async run(owner: string, input: unknown, signal?: AbortSignal) {
    this.accepting();
    if (signal?.aborted)
      throw new LocalError("Fixture request stopped before admission.", 408);
    const role = this.roles().stt;
    this.accepting();
    const admission = this.store.sttAdmissions.begin(owner, input, role);
    try {
      return await this.coordinator.run(owner, admission.id, signal);
    } catch {
      this.failed = true;
      throw new LocalError(
        "Local fixture execution failed; exclusive recovery is required.",
        503,
      );
    }
  }
  recent(owner: string) {
    return this.store.sttAdmissions.list(owner);
  }
  view(owner: string, id: string) {
    const row = this.store.sttAdmissions.get(owner, id);
    return {
      id: row.id,
      request_id: row.request_id,
      media_id: row.mediaId,
      consent_revision: row.consentRevision,
      mode: "fixture" as const,
      notice: "Synthetic tone lookup only; not speech recognition.",
      state: row.state,
      pending: row.pending,
      expires_at: row.expiresAt,
      outcome: row.outcome,
    };
  }
  stop() {
    this.stopping = true;
    return this.coordinator.stop();
  }
  async drain() {
    await this.coordinator.drain();
    if (this.failed)
      throw new LocalError(
        "Local fixture execution failed; exclusive recovery is required.",
        503,
      );
  }
  shutdown(
    server: { stop(force?: boolean): Promise<void> },
    closeStore: () => void,
  ) {
    if (this.closing) return this.closing;
    this.stop();
    this.closing = Promise.resolve()
      .then(async () => {
        const stopped = server.stop(false);
        // Drain failure must not leave an eventual server-stop rejection unhandled.
        void stopped.catch(() => {});
        await this.drain();
        await stopped;
        closeStore();
      })
      .catch(() => {
        this.failed = true;
        throw new LocalError(
          "Fixture shutdown could not finish safely; exclusive recovery is required.",
          503,
        );
      });
    return this.closing;
  }
}
