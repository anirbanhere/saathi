export function createMediaConsole({
  api,
  run,
  el,
  button,
  onPrivacyChange = () => {},
}) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $("#saved-media"),
    fields = $("#media-controls"),
    list = $("#media-records"),
    status = $("#media-status"),
    refreshButton = $("#media-refresh");
  let enabled = false,
    uploadAvailable = false,
    loading = false,
    busy = false;
  const controls = () => {
    fields.disabled = busy || loading || !enabled;
  };
  const time = (value) =>
    new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const names = {
    "en-IN": "English",
    "hi-IN": "हिन्दी",
    "ta-IN": "தமிழ்",
    "ml-IN": "മലയാളം",
    "kn-IN": "ಕನ್ನಡ",
  };
  async function change(record, suffix, method, message) {
    onPrivacyChange();
    try {
      await api(
        `/api/media/${encodeURIComponent(record.id)}${suffix}`,
        {},
        method,
      );
      await refresh();
      status.textContent = message;
    } catch (error) {
      list.replaceChildren();
      status.textContent =
        "Could not confirm the change. Refresh saved media to check before trying again.";
      throw error;
    }
  }
  function row(record) {
    const item = el("li");
    item.className = "appointment-task media-record";
    item.append(
      el(
        "h3",
        `Clip ${record.id.slice(0, 8)} · ${names[record.languageHint] || "Language not specified"}`,
      ),
    );
    const states = {
      active: "Stored",
      expired: "Access expired",
      deleted: "Deleted from active storage",
      revoked: "Storage consent revoked",
    };
    item.append(
      el(
        "p",
        `${states[record.state] || "Saved status"} · ${(record.durationMs / 1000).toFixed(2)} seconds · ${(record.byteLength / 1024).toFixed(1)} KB`,
      ),
    );
    const details = el("dl");
    details.className = "media-details";
    for (const [label, value] of [
      ["Stored", `${time(record.createdAt)} IST`],
      ["Access expires", `${time(record.expiresAt)} IST`],
      ["Storage consent recorded", record.consentToStore ? "Yes" : "No"],
      ["Processing consent recorded", record.consentToProcess ? "Yes" : "No"],
    ])
      details.append(el("dt", label), el("dd", value));
    item.append(details);
    if (
      !record.removedAt &&
      record.consentToStore &&
      ["active", "expired"].includes(record.state)
    ) {
      const actions = el("div");
      actions.className = "appointment-actions";
      if (record.consentToProcess)
        actions.append(
          button(
            "Revoke processing consent",
            () =>
              change(
                record,
                "/revoke-processing",
                "POST",
                "Processing consent revoked. Copies already returned cannot be recalled.",
              ),
            "secondary",
            refreshButton,
          ),
        );
      const remove = el("button", "Delete stored clip");
      remove.type = "button";
      remove.className = "secondary";
      const confirmation = el("div");
      confirmation.className = "notice media-confirm";
      confirmation.hidden = true;
      confirmation.setAttribute("role", "group");
      confirmation.setAttribute(
        "aria-label",
        `Confirm deletion of clip ${record.id.slice(0, 8)}`,
      );
      confirmation.append(
        el(
          "p",
          "Delete this clip from active storage and clear the transcription saved with it? Clip details and backups may remain.",
        ),
      );
      const cancel = el("button", "Keep clip");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.addEventListener("click", () => {
        confirmation.hidden = true;
        remove.hidden = false;
        remove.focus();
      });
      const confirm = button(
        "Delete clip",
        () =>
          change(
            record,
            "",
            "DELETE",
            "Clip removed from active storage. Clip details and backups may remain.",
          ),
        "secondary",
        refreshButton,
      );
      confirmation.append(confirm, cancel);
      remove.addEventListener("click", () => {
        remove.hidden = true;
        confirmation.hidden = false;
        cancel.focus();
      });
      actions.append(remove);
      item.append(actions, confirmation);
    }
    return item;
  }
  async function refresh() {
    if (!enabled) return;
    loading = true;
    controls();
    status.textContent = "Loading saved media…";
    try {
      const records = await api("/api/media");
      list.replaceChildren(...records.map(row));
      status.textContent = records.length
        ? `${records.length} saved clip records. Recorded consent is not a new processing permission.`
        : uploadAvailable
          ? "No saved clips in this workspace. Save an audio clip below to get started."
          : "No saved clips in this workspace. Audio upload is not connected.";
    } catch (error) {
      list.replaceChildren();
      status.textContent =
        error.status === 401 || error.status === 403
          ? "This workspace is unavailable or expired. Refresh the page to start again."
          : "Saved media could not be loaded. Refresh to try again.";
      throw error;
    } finally {
      loading = false;
      controls();
    }
  }
  refreshButton.addEventListener("click", () => run(refresh, refreshButton));
  return {
    refresh,
    setBusy(value) {
      busy = value;
      controls();
    },
    async initialize() {
      panel.hidden = true;
      enabled = false;
      list.replaceChildren();
      controls();
      try {
        const health = await api("/health");
        enabled =
          health.local_media_controls === true && health.public_demo === false;
        uploadAvailable = enabled && health.local_media_uploads === true;
        panel.hidden = !enabled;
        controls();
        if (enabled) await refresh();
      } catch {
        /* A media-only failure must not disable the other workspace panels. */
      }
    },
  };
}
