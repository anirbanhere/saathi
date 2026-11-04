export function createPlanConsole({ api, run, el, button, statusControl }) {
  const $ = (selector) => document.querySelector(selector);
  let pending = null,
    sending = false,
    globallyBusy = false;
  const states = {
    PLANNING: "Preparing a proposal… refresh to check or cancel",
    DRAFT_READY: "Draft ready · no steps executed",
    NEEDS_CLARIFICATION:
      "Needs your clarification · create a new plan with those details",
    UNAVAILABLE: "Requested capability unavailable",
    FAILED:
      "Planning failed · no steps executed; another attempt uses the model allowance",
    INTERRUPTED: "Interrupted on restart · not replayed",
    CANCELLED: "Cancelled · late proposals are discarded",
  };
  function controls() {
    $("#plan-fields").disabled = globallyBusy || sending;
    for (const id of [
      "plan-goal",
      "plan-date",
      "plan-locale",
      "plan-model-select",
    ])
      $(`#${id}`).disabled = globallyBusy || sending || Boolean(pending);
    $("#plan-create").textContent = pending
      ? "Check previous request"
      : "Draft a plan";
    $("#plan-create").disabled =
      globallyBusy || sending || (!pending && !$("#plan-model-select").value);
  }
  function evidence(result) {
    const section = el("div");
    section.className = "notice";
    section.append(
      el("h4", "Saved read-only checks"),
      el(
        "p",
        `Recorded ${new Date(result.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. This evidence is cached; refreshing does not run checks again.`,
      ),
      el(
        "p",
        "No booking, payment or message was created. Mock availability can change; review the separate appointment panel before a simulated booking.",
      ),
    );
    const labels = {
      completed: "Read completed",
      unavailable: "Unavailable",
      requires_user_action: "Needs manual action",
      retryable: "Check failed · no automatic retry",
      permanently_failed: "Invalid result rejected",
    };
    for (const row of result.results) {
      section.append(
        el(
          "p",
          `${labels[row.status] || "Saved outcome"} · ${row.evidence_mode === "mock" ? "controlled simulation" : row.evidence_mode === "draft" ? "unverified draft" : "no source evidence"}${row.skipped ? " · step skipped" : ""}`,
        ),
      );
      if (row.output.reason) section.append(el("p", row.output.reason));
      if (row.output.instructions)
        section.append(el("p", row.output.instructions));
      if (row.output.slots) {
        section.append(
          el("p", `${row.output.clinic} · ${row.output.date} · MOCK`),
        );
        const list = el("ul");
        for (const slot of row.output.slots) list.append(el("li", slot.label));
        section.append(list);
      }
    }
    return section;
  }
  async function refresh() {
    const records = await api("/api/task-plans"),
      list = $("#plan-tasks");
    if (
      pending &&
      records.some(
        (task) =>
          task.input.request_id === pending.request_id &&
          task.state !== "PLANNING",
      )
    )
      pending = null;
    list.replaceChildren();
    for (const task of records) {
      const card = el("article");
      card.className = "appointment-task";
      card.append(
        el("h3", task.input.goal),
        el(
          "p",
          task.read_result && task.state === "DRAFT_READY"
            ? "Saved proposal · read-only checks recorded"
            : states[task.state] || "Saved draft state",
        ),
        el("p", `Reasoning: ${task.roles.reasoning.id} · ${task.input.locale}`),
      );
      if (task.input.date)
        card.append(el("p", `User-confirmed date: ${task.input.date} (India)`));
      if (task.plan?.question) card.append(el("p", task.plan.question));
      if (task.plan?.unavailable_reason)
        card.append(el("p", task.plan.unavailable_reason));
      if (task.plan?.steps.length) {
        const steps = el("ol");
        for (const step of task.plan.steps) {
          const item = el("li");
          item.append(
            el("p", step.description),
            el(
              "p",
              step.tool === "demo.clinic.options"
                ? "Demo clinic availability · read only · proposed"
                : "Manual guidance · unverified draft",
            ),
            el(
              "p",
              step.tool === "demo.clinic.options"
                ? `Date: ${step.arguments.date}`
                : step.arguments.instructions,
            ),
            el("p", `Expected: ${step.expected_output}`),
          );
          steps.append(item);
        }
        card.append(steps);
      }
      if (task.read_result) card.append(evidence(task.read_result));
      const actions = el("div");
      actions.className = "appointment-actions";
      if (task.state === "DRAFT_READY" && !task.read_result)
        actions.append(
          button("Run read-only checks", async () => {
            try {
              await api(`/api/task-plans/${task.id}/run-readonly`, {});
              $("#plan-status").textContent =
                "Read-only results saved. No booking or external action was performed.";
            } finally {
              await refresh();
              list.focus();
            }
          }),
        );
      if (!["CANCELLED", "FAILED", "INTERRUPTED"].includes(task.state))
        actions.append(
          button("Cancel this draft", async () => {
            await api(`/api/task-plans/${task.id}/cancel`, {});
            $("#plan-status").textContent = states.CANCELLED;
            await refresh();
            list.focus();
          }),
        );
      if (actions.childElementCount) card.append(actions);
      const history = el("details"),
        summary = el("summary", "Plan activity");
      history.append(summary);
      for (const event of task.events)
        history.append(
          el(
            "p",
            `${event.event} · ${new Date(event.at).toLocaleString("en-IN")}`,
          ),
        );
      card.append(history);
      if (statusControl)
        card.append(statusControl("task_plan", task.id, task.input.goal));
      list.append(card);
    }
    if (!records.length)
      list.append(
        el(
          "p",
          "No saved plans yet. Try a demo dental-slot goal or ask for manual guidance.",
        ),
      );
    controls();
  }
  $("#plan-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (globallyBusy || sending) return;
    if (!pending && !$("#plan-model-select").value) {
      $("#plan-status").textContent =
        "Choose a permitted reasoning model first.";
      return;
    }
    if (!pending)
      pending = {
        request_id: crypto.randomUUID(),
        goal: $("#plan-goal").value.trim(),
        locale: $("#plan-locale").value,
        reasoning_model: $("#plan-model-select").value,
        ...($("#plan-date").value ? { date: $("#plan-date").value } : {}),
      };
    sending = true;
    controls();
    $("#plan-status").textContent =
      "Preparing a saved proposal. You can refresh saved plans and cancel while it runs.";
    try {
      const task = await api("/api/task-plans", pending);
      if (task.state !== "PLANNING") pending = null;
      $("#plan-status").textContent = states[task.state] || "Saved draft state";
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 408)
        pending = null;
      $("#plan-status").textContent = error.message;
    } finally {
      sending = false;
      try {
        await refresh();
      } catch {
        $("#plan-status").textContent +=
          " Could not refresh saved state. Check the previous request before a new attempt.";
      }
      controls();
      $("#plan-tasks").focus();
    }
  });
  $("#plan-refresh").addEventListener("click", () =>
    run(refresh, $("#plan-tasks")),
  );
  $("#plan-model-select").addEventListener("change", controls);
  return {
    refresh,
    setBusy(value) {
      globallyBusy = value;
      controls();
    },
    async initialize() {
      const roles = await api("/api/provider-roles");
      const catalog = await api("/api/models"),
        picker = $("#plan-model-select");
      picker.replaceChildren(new Option("Choose a reasoning model", ""));
      for (const model of catalog.models)
        picker.append(
          new Option(
            `${model.name} · ${model.provider === "meta" ? "Meta (separately enabled)" : model.inputPerMillion === 0 && model.outputPerMillion === 0 ? "Free" : `$${model.inputPerMillion} input / $${model.outputPerMillion} output per 1M tokens`} · Text planning`,
            model.id,
          ),
        );
      if (catalog.models.some((model) => model.id === roles.reasoning?.id))
        picker.value = roles.reasoning.id;
      $("#plan-model").textContent = roles.reasoning
        ? `Default: ${roles.reasoning.id}. Choose independently from the reply model. One attempt per new goal, shared with chat. Selected provider receives this goal; planning has no web tools or paid fallback. Saved plans keep their original model.`
        : "Planner not configured.";
      await refresh();
    },
  };
}
