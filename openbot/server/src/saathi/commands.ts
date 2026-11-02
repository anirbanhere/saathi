import type { ApprovalService } from "../approvals/service";
import {
  SaathiConfigurationError,
  type SaathiModels,
  modelName,
  modelProvider,
} from "./models";
import type { Connection } from "./connection-store";

export async function whatsappCommand(input: {
  text: string;
  connection: Connection;
  models: SaathiModels;
  approvals: Pick<ApprovalService, "inbox" | "decide" | "answerQuestion">;
}): Promise<string | null> {
  const { text, connection, models, approvals } = input;
  const command = text.trim();
  if (command === "/help")
    return "Ask for a task in Tamil, Hindi, Malayalam, or English.\n/models - view saved models\n/model <provider> <model> - switch for the next run\n/status - current model\n/stop - stop current and queued work\n/allow <approval-id> or /deny <approval-id> - decide an exact action\n/handled <approval-id> - confirm you completed a handover\n/answer <question-id> <reply> - answer a saved question.\nKeep passwords and API keys out of this chat; use Settings > Saathi in the companion.";
  if (command === "/models" || command === "/status") {
    const values = await models.status(connection.ownerUserId);
    return values.length
      ? values
          .map(
            (value) =>
              `${value.selected ? "Selected: " : "Available: "}${value.provider} ${value.model}`,
          )
          .join("\n")
      : "Add a model API key in the companion at Settings > Saathi.";
  }
  const select = command.match(
    /^\/model\s+(openai|anthropic|meta)\s+([a-zA-Z0-9._-]+)$/,
  );
  if (select) {
    await models.select(
      connection.ownerUserId,
      modelProvider.parse(select[1]),
      modelName.parse(select[2]),
    );
    return `The next run will use ${select[1]} ${select[2]}. Existing work keeps its current model.`;
  }
  const decide = command.match(/^\/(allow|deny|handled)\s+(\S+)$/);
  if (decide) {
    const inbox = await approvals.inbox(connection.ownerUserId);
    const request = inbox.requests.find(
      (request) =>
        request.id === decide[2] &&
        request.status === "pending" &&
        request.action.botId === connection.agentId &&
        request.action.threadId === connection.threadId,
    );
    if (!request || Date.now() - request.createdAt.getTime() > 15 * 60_000)
      throw new SaathiConfigurationError(
        "That approval is unavailable or expired. Review current requests in the companion.",
      );
    if (
      request.action.policy?.behaviour === "hand_off" &&
      decide[1] === "allow"
    )
      throw new SaathiConfigurationError(
        "Complete this action yourself using the companion handover, then reply /handled with its approval ID.",
      );
    if (decide[1] === "allow" && JSON.stringify(request.action).length > 3000)
      throw new SaathiConfigurationError(
        "This action is too large to review completely in WhatsApp. Review and decide it in the companion.",
      );
    await approvals.decide(
      connection.ownerUserId,
      request.id,
      decide[1] === "allow"
        ? "allow_once"
        : decide[1] === "handled"
          ? "handled"
          : "deny",
    );
    return decide[1] === "deny"
      ? "Declined. That action will not be carried out."
      : "Your decision is recorded. Saathi will continue through the approval gateway.";
  }
  const answer = command.match(/^\/answer\s+(\S+)\s+([\s\S]+)$/);
  const questionId = answer?.[1];
  const response = answer?.[2];
  if (questionId && response) {
    const inbox = await approvals.inbox(connection.ownerUserId);
    if (
      !inbox.questions.some(
        (question) =>
          question.id === questionId &&
          question.conversationBotId === connection.agentId &&
          question.threadId === connection.threadId,
      )
    )
      throw new SaathiConfigurationError(
        "That question is not available in this conversation.",
      );
    await approvals.answerQuestion(
      connection.ownerUserId,
      questionId,
      response,
    );
    return "Your answer is recorded. Saathi will continue the task.";
  }
  if (command.startsWith("/"))
    return "That command is not recognized. Send /help for the available commands.";
  return null;
}

export async function pendingDecisions(
  approvals: Pick<ApprovalService, "inbox">,
  connection: Connection,
) {
  const inbox = await approvals.inbox(connection.ownerUserId);
  const actions = inbox.requests
    .filter(
      (request) =>
        request.status === "pending" &&
        request.action.botId === connection.agentId &&
        request.action.threadId === connection.threadId,
    )
    .map((request) => {
      if (JSON.stringify(request.action).length > 3000)
        return `Approval ${request.id} requires a detailed review. Open the companion to inspect and decide this action, or reply /deny ${request.id}.`;
      const details = JSON.stringify({
        tool: request.action.toolRef,
        target: request.action.target,
        arguments: request.action.args,
      });
      const decision =
        request.action.policy?.behaviour === "hand_off"
          ? `/handled ${request.id} after completing this yourself in the companion`
          : `/allow ${request.id}`;
      return `Approval ${request.id}\n${details}\nReply ${decision}, or /deny ${request.id}. Review the full request in the companion if it is too long for chat.`;
    })
    .join("\n\n");
  const questions = inbox.questions
    .filter(
      (question) =>
        question.conversationBotId === connection.agentId &&
        question.threadId === connection.threadId,
    )
    .map(
      (question) =>
        `Question ${question.id}\n${question.question}\nReply /answer ${question.id} followed by your answer.`,
    )
    .join("\n\n");
  return [actions, questions].filter(Boolean).join("\n\n");
}
