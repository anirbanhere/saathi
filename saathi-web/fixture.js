export function createFixtureConsole({ api, run, el, button }) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $("#fixture-speech"),
    fields = $("#fixture-fields"),
    select = $("#fixture-clip"),
    form = $("#fixture-form"),
    refreshButton = $("#fixture-refresh"),
    send = $("#fixture-run"),
    check = $("#fixture-check"),
    clear = $("#fixture-clear"),
    cancel = $("#fixture-stop"),
    list = $("#fixture-history"),
    detail = $("#fixture-result"),
    status = $("#fixture-status"),
    pendingNote = $("#fixture-pending");
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const states = {
    reserved: "Reserved",
    claimed: "Claimed",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    blocked: "Blocked",
    revoked: "Revoked",
    expired: "Expired",
  };
  let enabled = false,
    busy = false,
    focusAfterFailure = false,
    intent = null,
    admissionId = null,
    controller = null,
    clips = new Map();
  function controls() {
    fields.disabled = busy || !enabled || Boolean(intent);
    refreshButton.disabled = busy || !enabled;
    send.disabled =
      busy ||
      !enabled ||
      (intent ? Boolean(admissionId) : !clips.has(select.value));
    send.textContent = intent
      ? "Retry same fixture request"
      : "Run a new fixture test";
    check.hidden = clear.hidden = !intent;
    check.disabled = clear.disabled = busy || !enabled;
    cancel.hidden = !controller;
    cancel.disabled = !controller;
    pendingNote.textContent = intent
      ? `An unresolved request for clip ${intent.media_id.slice(0, 8)} is kept in this tab. Checking saved status does not rerun it.`
      : "";
  }
  function clearDetail() {
    detail.replaceChildren();
  }
  function show(result) {
    if (
      result?.mode !== "fixture" ||
      !uuid.test(result.id) ||
      !uuid.test(result.media_id) ||
      !Object.hasOwn(states, result.state) ||
      typeof result.pending !== "boolean"
    )
      throw Error("Fixture result could not be verified.");
    const content = [
      el("h3", `Fixture ${result.id.slice(0, 8)} · ${states[result.state]}`),
      el("p", `Clip ${result.media_id.slice(0, 8)} · Synthetic result`),
      el(
        "p",
        "Synthetic tone lookup only. This is not speech recognition or an action receipt.",
      ),
    ];
    const outcome = result.outcome;
    if (outcome?.status === "completed") {
      const t = outcome.transcript;
      if (
        result.state !== "completed" ||
        result.pending ||
        t?.source?.mode !== "fixture" ||
        !["fixture-a", "fixture-b"].includes(t.source.provider) ||
        t.source.model !== "synthetic-stt-v1" ||
        typeof t.text !== "string" ||
        t.text.length > 20000
      )
        throw Error("Fixture result could not be verified.");
      const text = el("p", t.text);
      text.className = "fixture-text";
      content.push(
        el(
          "p",
          `Fixture provider: ${t.source.provider}. Text stays in this review panel.`,
        ),
        text,
      );
    } else if (outcome?.status === "failed") {
      const messages = {
        provider_failed:
          "This audio does not match an available synthetic example. Real speech recognition is not connected.",
        timeout:
          "Fixture attempt timed out. Check saved status before starting another.",
        aborted:
          "Fixture attempt stopped. Viewing status does not use another allowance.",
      };
      if (!Object.hasOwn(messages, outcome.code))
        throw Error("Fixture result could not be verified.");
      content.push(el("p", messages[outcome.code]));
    } else if (outcome !== null)
      throw Error("Fixture result could not be verified.");
    else
      content.push(
        el(
          "p",
          result.pending
            ? "A worker still needs to acknowledge. Refresh saved status; no automatic rerun is made."
            : "No text is available under the current consent, retention or saved execution state.",
        ),
      );
    detail.replaceChildren(...content);
    if (
      intent &&
      result.request_id === intent.request_id &&
      result.media_id === intent.media_id &&
      result.consent_revision === intent.consent_revision
    ) {
      admissionId = result.id;
      if (!result.pending) {
        intent = null;
        admissionId = null;
      }
    }
    controls();
  }
  function message(error) {
    return error.status === 401 || error.status === 403
      ? "This workspace is unavailable or expired. Refresh the page to start again."
      : "Fixture status could not be confirmed. Refresh saved status before trying another request.";
  }
  async function view(id) {
    clearDetail();
    try {
      const result = await api(`/api/fixture-stt/${encodeURIComponent(id)}`);
      if (result.id !== id) throw Error("Unconfirmed fixture identity");
      show(result);
      status.textContent =
        "Showing an owned synthetic result. No work was rerun.";
    } catch (error) {
      clearDetail();
      status.textContent = message(error);
      throw Error(status.textContent);
    }
  }
  function history(rows) {
    if (!Array.isArray(rows)) throw Error("Fixture history is unavailable.");
    list.replaceChildren(
      ...rows.slice(0, 20).map((row) => {
        if (
          !uuid.test(row.id) ||
          row.mode !== "fixture" ||
          !Object.hasOwn(states, row.state)
        )
          throw Error("Fixture history is unavailable.");
        const item = el("li");
        item.className = "appointment-task";
        item.append(
          el("h3", `Fixture ${row.id.slice(0, 8)} · ${states[row.state]}`),
          el(
            "p",
            row.pending
              ? "Worker acknowledgement is still pending."
              : "Saved state only; this is not current processing permission.",
          ),
          button(
            "View fixture result",
            () => view(row.id),
            "secondary",
            refreshButton,
          ),
        );
        return item;
      }),
    );
  }
  async function refresh() {
    if (!enabled) return;
    clearDetail();
    try {
      const [records, rows] = await Promise.all([
        api("/api/media"),
        api("/api/fixture-stt"),
      ]);
      if (!Array.isArray(records)) throw Error("Saved clips are unavailable.");
      const previous = select.value;
      clips = new Map(
        records
          .filter(
            (r) =>
              uuid.test(r.id) &&
              r.state === "active" &&
              r.consentToProcess === true &&
              r.expiresAt > Date.now() &&
              r.durationMs >= 100 &&
              r.durationMs <= 29000 &&
              (!r.languageHint ||
                ["en-IN", "hi-IN", "ta-IN"].includes(r.languageHint)),
          )
          .map((r) => [r.id, r]),
      );
      const prompt = el(
        "option",
        clips.size
          ? "Choose a saved synthetic clip"
          : "No available clips with processing consent",
      );
      prompt.value = "";
      select.replaceChildren(
        prompt,
        ...[...clips.values()].map((r) => {
          const option = el(
            "option",
            `Clip ${r.id.slice(0, 8)} · ${r.languageHint || "No language hint"}`,
          );
          option.value = r.id;
          return option;
        }),
      );
      if (clips.has(previous)) select.value = previous;
      history(rows);
      status.textContent = `${rows.length} recent fixture attempts. Refresh and viewing do not run a test.`;
    } catch (error) {
      clips.clear();
      select.replaceChildren();
      list.replaceChildren();
      clearDetail();
      status.textContent = message(error);
      throw Error(status.textContent);
    } finally {
      controls();
    }
  }
  refreshButton.addEventListener("click", () => run(refresh, refreshButton));
  select.addEventListener("change", () => {
    clearDetail();
    controls();
  });
  cancel.addEventListener("click", () => controller?.abort());
  check.addEventListener("click", () =>
    run(async () => {
      if (!intent) return;
      clearDetail();
      try {
        if (admissionId) {
          await view(admissionId);
          return;
        }
        const rows = await api("/api/fixture-stt");
        history(rows);
        const saved = rows.find(
          (r) =>
            r.request_id === intent.request_id &&
            r.media_id === intent.media_id &&
            r.consent_revision === intent.consent_revision,
        );
        if (saved) admissionId = saved.id;
        if (admissionId) await view(admissionId);
        else
          status.textContent =
            "No matching request was found among recent attempts. You may explicitly retry this same request.";
      } catch (error) {
        clearDetail();
        status.textContent = message(error);
        throw Error(status.textContent);
      }
    }, refreshButton),
  );
  clear.addEventListener("click", () =>
    run(async () => {
      await refresh();
      intent = null;
      admissionId = null;
      select.value = "";
      controls();
      status.textContent =
        "Selection cleared. Saved attempts and their allowances are unchanged.";
    }, select),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!enabled || busy) return;
    run(async () => {
      if (!intent) {
        const clip = clips.get(select.value);
        if (!clip) throw Error("Choose an available saved clip first.");
        intent = Object.freeze({
          request_id: crypto.randomUUID(),
          media_id: clip.id,
          consent_revision: clip.consentRevision,
        });
      }
      if (admissionId)
        throw Error(
          "Check the saved status of this pending request; do not start another.",
        );
      clearDetail();
      controller = new AbortController();
      controls();
      status.textContent = "Running a synthetic fixture test…";
      try {
        const result = await api(
          `/api/media/${encodeURIComponent(intent.media_id)}/fixture-stt`,
          {
            request_id: intent.request_id,
            consent_revision: intent.consent_revision,
          },
          "POST",
          controller.signal,
        );
        if (
          result.request_id !== intent.request_id ||
          result.media_id !== intent.media_id ||
          result.consent_revision !== intent.consent_revision
        )
          throw Error("Unconfirmed fixture identity");
        show(result);
        status.textContent =
          "Fixture status saved. Viewing it does not run another test.";
      } catch (error) {
        clearDetail();
        focusAfterFailure = true;
        status.textContent = controller.signal.aborted
          ? "Request stopped. A worker may still need to acknowledge; check saved status or retry the same request."
          : message(error);
        throw Error(status.textContent);
      } finally {
        controller = null;
        controls();
      }
      try {
        history(await api("/api/fixture-stt"));
      } catch {
        clearDetail();
        list.replaceChildren();
        status.textContent =
          "The fixture response was confirmed, but history could not be refreshed. Refresh clips and tests before viewing the result.";
      }
    }, refreshButton);
  });
  return {
    setBusy(value) {
      busy = value;
      controls();
      if (!busy && focusAfterFailure) {
        focusAfterFailure = false;
        if (!check.hidden) check.focus();
      }
    },
    privacyChanged() {
      clearDetail();
      clips.clear();
      select.replaceChildren();
      status.textContent =
        "Privacy changed. Refresh clips and tests to check current availability.";
      controls();
    },
    async initialize() {
      enabled = false;
      panel.hidden = true;
      controls();
      try {
        const health = await api("/health");
        enabled =
          health.fixture_speech === true &&
          health.local_media_controls === true &&
          health.public_demo === false;
        panel.hidden = !enabled;
        controls();
        if (enabled) await refresh();
      } catch {
        /* Fixture-only failure leaves other panels available. */
      }
    },
  };
}
