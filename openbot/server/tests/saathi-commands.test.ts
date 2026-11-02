import { expect, test } from "bun:test";
import type { ApprovalService } from "../src/approvals/service";
import { pendingDecisions, whatsappCommand } from "../src/saathi/commands";
import type { Connection } from "../src/saathi/connection-store";
import { createSaathiModels, type ModelKeyStore } from "../src/saathi/models";

const connection = {
  ownerUserId: "owner",
  agentId: "bot",
  threadId: "thread",
} as Connection;
const store: ModelKeyStore = {
  save: async () => {},
  select: async () => false,
  read: async () => null,
  list: async () => [],
  revoke: async () => {},
};
const models = createSaathiModels(
  store,
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
);
function approvals() {
  const answers: string[] = [];
  const service: Pick<ApprovalService, "inbox" | "decide" | "answerQuestion"> =
    {
      inbox: async (owner) => {
        expect(owner).toBe("owner");
        return {
          enabled: true,
          rules: [],
          teamRules: [],
          requests: [],
          questions: [
            {
              id: "question",
              botId: "bot",
              conversationBotId: "bot",
              threadId: "thread",
              question: "What time suits you?",
              why: undefined,
              createdAt: new Date(),
            },
            {
              id: "foreign",
              botId: "another",
              conversationBotId: "another",
              threadId: "foreign-thread",
              question: "Private",
              why: undefined,
              createdAt: new Date(),
            },
          ],
        };
      },
      decide: async () => {
        throw new Error("An unknown approval must never execute");
      },
      answerQuestion: async (_owner, id) => {
        answers.push(id);
        return { id, queued: true };
      },
    };
  return { service, answers };
}
test("WhatsApp clarification includes a usable question ID only for its own bot and thread", async () => {
  const value = await pendingDecisions(approvals().service, connection);
  expect(value).toContain("/answer question");
  expect(value).toContain("What time suits you?");
  expect(value).not.toContain("Private");
});
test("WhatsApp answers cannot target another conversation", async () => {
  const { service, answers } = approvals();
  await expect(
    whatsappCommand({
      text: "/answer foreign yes",
      connection,
      models,
      approvals: service,
    }),
  ).rejects.toThrow("not available");
  await whatsappCommand({
    text: "/answer question morning",
    connection,
    models,
    approvals: service,
  });
  expect(answers).toEqual(["question"]);
});
test("WhatsApp approvals must exist in the current owner's pending inbox", async () => {
  await expect(
    whatsappCommand({
      text: "/allow forged-id",
      connection,
      models,
      approvals: approvals().service,
    }),
  ).rejects.toThrow("unavailable");
});
