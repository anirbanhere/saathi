import { randomUUID } from "node:crypto";
import type { ApprovalService } from "../approvals/service";
import { decryptSecret } from "../credentials";
import type { TranscriptionProvider } from "../dictation/provider";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import type { WorkQueue } from "../work/queue";
import { repeatAfterEach } from "../work/loop";
import {
  type ConnectionStore,
  MESSAGE_WORK,
  type Connection,
} from "./connection-store";
import { SaathiConfigurationError, type SaathiModels } from "./models";
import { whatsappCommand, pendingDecisions } from "./commands";
import {
  createWhatsAppClient,
  WhatsAppError,
  type WhatsAppMessage,
} from "./whatsapp-client";

export function createSaathiWorkers(deps: {
  store: ConnectionStore;
  models: SaathiModels;
  queue: WorkQueue;
  encryptionKey: string;
  runTurn: TurnRunner;
  approvals: Pick<ApprovalService, "inbox" | "decide" | "answerQuestion">;
  transcription?: TranscriptionProvider;
  authorise(connection: Connection): Promise<boolean>;
  pollConcurrency?: number;
  clientFor?: typeof createWhatsAppClient;
}) {
  const owner = `saathi:${randomUUID()}`;
  const stopping = new AbortController();
  const client = async (connection: Connection) =>
    (deps.clientFor ?? createWhatsAppClient)(
      await decryptSecret(deps.encryptionKey, connection.encryptedToken),
    );
  const safeError = (error: unknown) =>
    error instanceof SaathiConfigurationError || error instanceof WhatsAppError
      ? error.message
      : "Saathi could not complete this turn. Check the companion for its current state before retrying any action.";
  async function poll() {
    const connection = await deps.store.claimPoll(owner);
    if (!connection) return;
    try {
      const batch = await (await client(connection)).poll(
        connection.cursor,
        stopping.signal,
      );
      await deps.store.commitBatch(connection, owner, batch);
    } catch (error) {
      await deps.store.pollFailed(
        connection,
        owner,
        error instanceof WhatsAppError &&
          [400, 401, 403].includes(error.status),
        safeError(error),
      );
    }
  }
  async function inbound() {
    const [work] = await deps.queue.claim({
      kind: MESSAGE_WORK,
      owner,
      leaseMs: 60_000,
      limit: 1,
      maxAttempts: 5,
    });
    if (!work) return;
    const claim = { kind: MESSAGE_WORK, key: work.key, owner };
    const saved = await deps.store.message(work.key);
    if (!saved) {
      await deps.queue.finish(claim);
      return;
    }
    const connection = await deps.store.byId(saved.connectionId);
    if (
      connection?.status !== "connected" ||
      !(await deps.authorise(connection))
    ) {
      await deps.queue.finish(claim);
      return;
    }
    if (saved.state !== "queued") {
      if (saved.state === "running")
        await deps.store.complete(
          saved.id,
          "A previous run was interrupted. Its external actions were not repeated. Review the conversation in the companion before asking me to continue.",
          "needs_review",
        );
      await deps.queue.finish(claim);
      return;
    }
    const message = saved.payload as WhatsAppMessage;
    if (Date.now() - saved.createdAt.getTime() > 24 * 60 * 60_000) {
      await deps.store.complete(
        saved.id,
        "This request is over a day old, so I did not execute it. Please send it again if it is still needed.",
        "expired",
      );
      await deps.queue.finish(claim);
      return;
    }
    if (!(await deps.store.startMessage(saved.id))) {
      await deps.queue.release({
        ...claim,
        delayMs: 1000,
        reason: "Conversation is busy.",
        unstarted: true,
      });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      stopping.signal,
      controller.signal,
      AbortSignal.timeout(5 * 60_000),
    ]);
    const heartbeat = repeatAfterEach(async () => {
      try {
        const current = await deps.store.byId(connection.id);
        if (
          current?.status !== "connected" ||
          current.cancelVersion !== connection.cancelVersion ||
          !(await deps.queue.renew({ ...claim, leaseMs: 60_000 }))
        )
          controller.abort();
      } catch {
        controller.abort();
      }
    }, 1000);
    try {
      if (saved.cancelVersion !== connection.cancelVersion) {
        await deps.store.complete(
          saved.id,
          "This queued request was stopped before it ran.",
          "cancelled",
        );
        return;
      }
      let text = message.text?.body;
      if (message.type === "audio" && message.audio) {
        if (!deps.transcription)
          throw new SaathiConfigurationError(
            "Voice transcription is not configured. Send your request as text, or ask the operator to configure the speech service.",
          );
        text = await deps.transcription.transcribe(
          await (await client(connection)).audio(message.audio.id, signal),
          signal,
        );
      }
      if (!text?.trim())
        throw new SaathiConfigurationError(
          "Send a text request or a supported voice note.",
        );
      if (text.length > 12_000)
        throw new SaathiConfigurationError(
          "Please shorten this request to 12,000 characters or less.",
        );
      let reply = await whatsappCommand({
        text,
        connection,
        models: deps.models,
        approvals: deps.approvals,
      });
      if (reply === null) {
        const result = await deps.runTurn({
          ownerUserId: connection.ownerUserId,
          agentId: connection.agentId,
          threadId: connection.threadId,
          routineId: saved.id,
          runId: saved.id,
          instruction: text,
          initiator: { kind: "person" },
          signal,
        });
        reply =
          [result.replyText, await pendingDecisions(deps.approvals, connection)]
            .filter(Boolean)
            .join("\n\n") ||
          "This turn finished. Open the companion to inspect the result or any required handover.";
      }
      if (await deps.queue.renew({ ...claim, leaseMs: 60_000 }))
        await deps.store.complete(saved.id, reply);
    } catch (error) {
      if (await deps.queue.renew({ ...claim, leaseMs: 60_000 }))
        await deps.store.complete(
          saved.id,
          signal.aborted
            ? "Stopped this run. An action already sent may still have completed; check the companion before trying it again."
            : safeError(error),
          signal.aborted ? "cancelled" : "failed",
        );
    } finally {
      heartbeat.stop();
      await deps.queue.finish(claim);
    }
  }
  async function outbound() {
    const item = await deps.store.takeOutbound();
    if (!item) return;
    try {
      const current = await deps.store.byId(item.connection.id);
      if (
        current?.status !== "connected" ||
        !current.participantId ||
        !(await deps.authorise(current))
      ) {
        await deps.store.finishOutbound(item.row.id, "failed");
        return;
      }
      const remoteId = await (await client(current)).send(
        current.participantId,
        item.row.text,
        stopping.signal,
      );
      await deps.store.finishOutbound(item.row.id, "sent", remoteId);
    } catch (error) {
      await deps.store.finishOutbound(
        item.row.id,
        error instanceof WhatsAppError && error.ambiguous
          ? "unknown"
          : error instanceof WhatsAppError && error.retryable
            ? "queued"
            : "failed",
      );
    }
  }
  return {
    poll,
    inbound,
    outbound,
    start() {
      const safe = (name: string, fn: () => Promise<void>) => async () => {
        try {
          await fn();
        } catch {
          console.error(
            JSON.stringify({ type: "saathi-worker-failed", worker: name }),
          );
        }
      };
      const loops = [
        ...Array.from(
          { length: Math.max(1, Math.min(50, deps.pollConcurrency ?? 25)) },
          () => repeatAfterEach(safe("poll", poll), 1000),
        ),
        ...Array.from({ length: 4 }, () =>
          repeatAfterEach(safe("inbound", inbound), 500),
        ),
        repeatAfterEach(safe("outbound", outbound), 500),
      ];
      return {
        stop() {
          stopping.abort();
          for (const loop of loops) loop.stop();
        },
      };
    },
  };
}
