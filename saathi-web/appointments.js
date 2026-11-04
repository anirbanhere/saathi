export function createAppointmentConsole({
  api,
  run,
  el,
  button,
  statusControl,
}) {
  const $ = (selector) => document.querySelector(selector);
  let pendingAppointmentCreate = null;
  const reviewNonces = new Map(),
    pendingDecisions = new Map();
  const appointmentStates = {
    AWAITING_SELECTION: "Choose a demo slot",
    APPROVAL_PENDING: "Review before mock booking",
    COMPLETED: "Mock booking confirmed",
    REJECTED: "Request rejected",
    CANCELLED: "Request cancelled",
    EXPIRED: "Review expired — review a slot again",
    UNAVAILABLE: "Slot taken — choose another demo slot",
  };
  function appointmentQuote(quote) {
    const recap = el("div");
    recap.className = "notice";
    recap.append(
      el("p", `${quote.clinic} · ${quote.city} · ${quote.service}`),
      el(
        "p",
        `${quote.date} · ${quote.slot_id} IST · ${quote.duration_minutes} minutes · Simulated total ₹${quote.amount} ${quote.currency}`,
      ),
      el("p", quote.terms),
    );
    return recap;
  }
  async function appointmentAction(action) {
    try {
      return await action();
    } finally {
      await appointments();
      $("#appointment-tasks").focus();
    }
  }
  async function reviewAppointment(task, slotId) {
    reviewNonces.delete(task.id);
    await appointmentAction(async () => {
      const review = await api(`/api/demo-appointments/${task.id}/preview`, {
        slot_id: slotId,
        version: task.version,
      });
      reviewNonces.set(task.id, {
        nonce: review.nonce,
        version: review.task.version,
      });
    });
  }
  async function decideAppointment(task, decision) {
    let body = pendingDecisions.get(task.id);
    if (!body) {
      const review = reviewNonces.get(task.id);
      if (!review || review.version !== task.version)
        throw new Error("Review this slot again before deciding.");
      body = {
        request_id: crypto.randomUUID(),
        version: task.version,
        nonce: review.nonce,
        decision,
      };
      pendingDecisions.set(task.id, body);
    }
    await appointmentAction(async () => {
      try {
        await api(`/api/demo-appointments/${task.id}/decision`, body);
        pendingDecisions.delete(task.id);
        reviewNonces.delete(task.id);
      } catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 408) {
          pendingDecisions.delete(task.id);
          reviewNonces.delete(task.id);
        }
        throw error;
      }
    });
  }
  async function appointments() {
    const records = await api("/api/demo-appointments"),
      list = $("#appointment-tasks");
    const dates = [
      ...new Set(
        records
          .filter(
            (task) =>
              !["COMPLETED", "REJECTED", "CANCELLED"].includes(task.state),
          )
          .map((task) => task.date),
      ),
    ];
    const availability = new Map(
      await Promise.all(
        dates.map(async (date) => {
          try {
            return [
              date,
              await api(
                `/api/demo-appointments/options?date=${encodeURIComponent(date)}`,
              ),
            ];
          } catch (error) {
            return [date, { slots: [], error: error.message }];
          }
        }),
      ),
    );
    list.replaceChildren();
    for (const task of records) {
      const pendingDecision = pendingDecisions.get(task.id);
      if (
        pendingDecision &&
        (pendingDecision.version !== task.version ||
          task.state !== "APPROVAL_PENDING")
      ) {
        pendingDecisions.delete(task.id);
        reviewNonces.delete(task.id);
      }
      const card = el("article");
      card.className = "appointment-task";
      card.append(
        el(
          "h3",
          `${task.date} · ${appointmentStates[task.state] || task.state}`,
        ),
      );
      if (task.receipt) {
        reviewNonces.delete(task.id);
        pendingDecisions.delete(task.id);
        card.append(
          el("p", task.receipt.summary),
          el("p", `Saved reference: ${task.receipt.reference}`),
          appointmentQuote(task.receipt.quote),
        );
      } else if (!["REJECTED", "CANCELLED"].includes(task.state)) {
        if (task.preview) card.append(appointmentQuote(task.preview));
        const actions = el("div");
        actions.className = "appointment-actions";
        const waiting = pendingDecisions.get(task.id);
        if (waiting)
          actions.append(
            button("Check previous decision", () =>
              decideAppointment(task, waiting.decision),
            ),
          );
        else {
          const reviewed = reviewNonces.get(task.id);
          if (
            task.state === "APPROVAL_PENDING" &&
            reviewed?.version === task.version
          ) {
            card.append(
              el(
                "p",
                `Review expires ${new Date(task.expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Approval applies only to the exact appointment above.`,
              ),
            );
            actions.append(
              button(
                "Approve mock booking",
                () => decideAppointment(task, "approve"),
                "primary",
              ),
              button("Reject request", () => decideAppointment(task, "reject")),
            );
          } else if (task.state === "APPROVAL_PENDING")
            card.append(
              el(
                "p",
                "Saved review found. Review a slot again to enable approval; approval tokens are not restored after reload.",
              ),
            );
          for (const slot of availability.get(task.date)?.slots || [])
            actions.append(
              button(`Review ${slot.id} IST`, () =>
                reviewAppointment(task, slot.id),
              ),
            );
          if (availability.get(task.date)?.error)
            card.append(
              el(
                "p",
                `Could not load demo slots: ${availability.get(task.date).error} Refresh demo tasks to check again.`,
              ),
            );
          else if (!availability.get(task.date)?.slots.length)
            card.append(
              el(
                "p",
                "No selectable slots for this date. Cancel this request and choose a new date.",
              ),
            );
          actions.append(
            button(
              "Cancel request",
              () =>
                appointmentAction(() =>
                  api(`/api/demo-appointments/${task.id}/cancel`, {
                    version: task.version,
                  }),
                ),
              "text-button",
            ),
          );
        }
        card.append(actions);
      } else {
        reviewNonces.delete(task.id);
        pendingDecisions.delete(task.id);
        card.append(el("p", "No mock booking was made."));
      }
      const details = el("details"),
        summary = el("summary", "Plan and saved activity"),
        steps = el("ol");
      for (const text of [
        "Check demo availability",
        "Review exact date, time and simulated amount",
        "Wait for your explicit approval",
        "Save and verify the mock booking reference",
      ])
        steps.append(el("li", text));
      details.append(summary, steps);
      for (const event of task.audit)
        details.append(
          el(
            "p",
            `${event.event.replaceAll(".", " ").replaceAll("_", " ")} · ${new Date(event.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
          ),
        );
      card.append(details);
      if (statusControl)
        card.append(
          statusControl(
            "demo_appointment",
            task.id,
            `Demo appointment on ${task.date}`,
          ),
        );
      list.append(card);
    }
    if (!records.length)
      list.append(
        el(
          "p",
          "No demo tasks yet. Pick a date to try the full review and approval flow.",
        ),
      );
  }
  $("#appointment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      if (!pendingAppointmentCreate)
        pendingAppointmentCreate = {
          request_id: crypto.randomUUID(),
          date: $("#appointment-date").value,
          locale: $("#appointment-locale").value,
        };
      await appointmentAction(async () => {
        try {
          await api("/api/demo-appointments", pendingAppointmentCreate);
          pendingAppointmentCreate = null;
        } catch (error) {
          if (error.status >= 400 && error.status < 500 && error.status !== 408)
            pendingAppointmentCreate = null;
          throw error;
        }
      });
    });
  });
  $("#appointment-refresh").addEventListener("click", () => run(appointments));

  return {
    refresh: appointments,
    initialize: async () => {
      const dates = await api("/api/demo-appointments/options");
      $("#appointment-date").min = dates.min_date;
      $("#appointment-date").max = dates.max_date;
      $("#appointment-date").value = new Date(
        Date.parse(`${dates.min_date}T00:00:00Z`) + 86400000,
      )
        .toISOString()
        .slice(0, 10);
      await appointments();
    },
    setBusy: (busy) => {
      $("#appointment-controls").disabled = busy;
      if (!busy) {
        $("#appointment-date").disabled = Boolean(pendingAppointmentCreate);
        $("#appointment-locale").disabled = Boolean(pendingAppointmentCreate);
        $("#appointment-create").textContent = pendingAppointmentCreate
          ? "Check previous task creation"
          : "Find demo slots";
      }
    },
  };
}
