import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const phone = z
  .string()
  .regex(/^\+91[1-9]\d{9}$/, "Use an Indian number in +91 format.");
const input = z.strictObject({
  number: phone,
  purpose: z.string().trim().min(3).max(500),
  disclosure: z.string().trim().min(1).max(500),
  language: z.enum(["en-IN", "hi-IN", "ta-IN", "ml-IN"]),
  maxSeconds: z.number().int().min(30).max(600),
});
export type CallStatus =
  | "awaiting_approval"
  | "ringing"
  | "connected"
  | "human_control"
  | "ended"
  | "canceled";
export type CallRecord = {
  id: string;
  owner: string;
  version: number;
  direction: "incoming" | "outgoing";
  status: CallStatus;
  number: string;
  purpose: string;
  disclosure: string;
  language: string;
  maxSeconds: number;
  previewHash: string;
  createdAt: number;
  expiresAt: number;
  simulated: true;
  callerVerified: false;
  recording: false;
  aiSpeaking: boolean;
  summary: string;
};
export interface CallStore {
  insert(row: CallRecord): Promise<void>;
  list(owner: string): Promise<CallRecord[]>;
  get(owner: string, id: string): Promise<CallRecord | null>;
  change(
    owner: string,
    id: string,
    version: number,
    patch: Partial<CallRecord>,
  ): Promise<boolean>;
}
export class CallError extends Error {}
const disclosure =
  "Hello, I am Saathi, an AI assistant. This is a test call; no phone is connected and no audio is recorded.";
export function createCallService(
  store: CallStore,
  options: { simulation: boolean; now?: () => number },
) {
  const now = options.now ?? Date.now;
  function enabled() {
    if (!options.simulation)
      throw new CallError(
        "Enable the private call simulator to test. Real calling needs provider and voice setup.",
      );
  }
  async function read(owner: string, id: string) {
    enabled();
    const row = await store.get(owner, id);
    if (!row) throw new CallError("Call not found.");
    if (!["ended", "canceled"].includes(row.status) && row.expiresAt <= now()) {
      const patch = {
        status: "canceled" as const,
        aiSpeaking: false,
        summary: "Session expired. No real call was placed.",
      };
      if (!(await store.change(owner, id, row.version, patch)))
        throw new CallError("Call changed. Reload and try again.");
      return { ...row, ...patch, version: row.version + 1 };
    }
    return row;
  }
  async function change(row: CallRecord, patch: Partial<CallRecord>) {
    if (!(await store.change(row.owner, row.id, row.version, patch)))
      throw new CallError("Call changed. Reload and try again.");
    return { ...row, ...patch, version: row.version + 1 };
  }
  async function create(
    owner: string,
    data: z.infer<typeof input>,
    direction: CallRecord["direction"],
  ) {
    enabled();
    const id = randomUUID();
    const createdAt = now();
    const row: CallRecord = {
      ...data,
      id,
      owner,
      direction,
      version: 0,
      status: direction === "outgoing" ? "awaiting_approval" : "ringing",
      previewHash: createHash("sha256")
        .update(JSON.stringify({ id, owner, direction, ...data, createdAt }))
        .digest("hex"),
      createdAt,
      expiresAt: createdAt + 10 * 60_000,
      simulated: true,
      callerVerified: false,
      recording: false,
      aiSpeaking: false,
      summary:
        direction === "incoming"
          ? disclosure
          : "Awaiting owner approval. No real call will be placed.",
    };
    await store.insert(row);
    return row;
  }
  return {
    readiness: () => ({
      mode: options.simulation ? "simulation" : "setup",
      liveCalling: false,
      provider: "exotel",
      numberAssigned: false,
      recording: false,
      required: [
        "Exotel account and approved Indian ExoPhone",
        "Bidirectional Voicebot enabled by provider",
        "Public authenticated webhook and media endpoint",
        "Voice speech credentials and call-minute budget",
        "Provider coverage and takeover verification",
      ],
    }),
    async list(owner: string) {
      if (!options.simulation) return [];
      return Promise.all(
        (await store.list(owner)).map((row) => read(owner, row.id)),
      );
    },
    request: async (owner: string, body: unknown) =>
      create(owner, input.parse(body), "outgoing"),
    incoming: async (owner: string, body: unknown) => {
      const value = z.strictObject({ number: phone }).parse(body);
      return create(
        owner,
        {
          ...value,
          purpose: "Take a message using the approved answering brief",
          disclosure: "No private owner data may be shared",
          language: "en-IN",
          maxSeconds: 120,
        },
        "incoming",
      );
    },
    async approve(owner: string, id: string, hash: string) {
      const row = await read(owner, id);
      if (
        row.direction !== "outgoing" ||
        row.status !== "awaiting_approval" ||
        hash !== row.previewHash
      )
        throw new CallError(
          "Approval must match the current call preview and must not be expired or reused.",
        );
      return change(row, {
        status: "ringing",
        expiresAt: now() + (row.maxSeconds + 30) * 1000,
        summary: "SIMULATION: ringing only. No carrier request was made.",
      });
    },
    async control(owner: string, id: string, action: string) {
      const row = await read(owner, id);
      if (["ended", "canceled"].includes(row.status))
        throw new CallError("This call is already over.");
      if (action === "end")
        return change(row, {
          status: row.status === "awaiting_approval" ? "canceled" : "ended",
          aiSpeaking: false,
          summary:
            "Simulation ended. No real phone call or recording was made.",
        });
      if (action === "answer" && row.status === "ringing")
        return change(row, {
          status: "connected",
          aiSpeaking: true,
          expiresAt: now() + row.maxSeconds * 1000,
          summary: disclosure,
        });
      if (action === "takeover" && row.status === "connected")
        return change(row, {
          status: "human_control",
          aiSpeaking: false,
          summary:
            "SIMULATION: AI stopped. Real transfer requires a provisioned carrier and authenticated owner voice session.",
        });
      throw new CallError(
        "That action is not available in the current call state.",
      );
    },
  };
}
export type CallService = ReturnType<typeof createCallService>;
