export function createAudioUpload({ api, run, upload, refresh }) {
  const $ = (selector) => document.querySelector(selector);
  const panel = $("#audio-upload"),
    form = $("#upload-form"),
    fields = $("#upload-fields"),
    file = $("#upload-file"),
    storage = $("#upload-storage"),
    processing = $("#upload-processing"),
    language = $("#upload-language"),
    status = $("#upload-status"),
    send = $("#upload-send"),
    cancel = $("#upload-cancel"),
    clear = $("#upload-clear");
  let enabled = false,
    busy = false,
    attempt = null,
    controller = null;
  const validFile = () =>
    file.files?.length === 1 &&
    /\.wav$/i.test(file.files[0].name) &&
    file.files[0].size >= 44 &&
    file.files[0].size <= 2_000_000;
  function controls() {
    fields.disabled = busy || Boolean(attempt) || !enabled;
    send.disabled =
      busy || !enabled || (!attempt && (!validFile() || !storage.checked));
    send.textContent = attempt ? "Retry same upload" : "Save audio clip";
    cancel.hidden = !controller;
    cancel.disabled = !controller;
    clear.hidden = !attempt;
    clear.disabled = busy;
  }
  function reset() {
    attempt = null;
    form.reset();
    controls();
  }
  for (const input of [file, storage, processing, language])
    input.addEventListener("change", () => {
      status.textContent =
        file.files?.length && !validFile()
          ? "Choose one supported PCM16 WAV file, up to 2 MB and 60 seconds."
          : "Nothing is sent until you choose Save audio clip.";
      controls();
    });
  cancel.addEventListener("click", () => controller?.abort());
  clear.addEventListener("click", () =>
    run(async () => {
      await refresh();
      reset();
      status.textContent =
        "Selection cleared. An earlier attempt may appear in saved audio; no clip was deleted.";
    }, file),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!enabled || busy) return;
    run(async () => {
      if (!attempt) {
        if (!validFile() || !storage.checked)
          throw new Error(
            "Select a bounded WAV file and agree to storage before uploading.",
          );
        attempt = Object.freeze({
          id: crypto.randomUUID(),
          file: file.files[0],
          process: processing.checked,
          language: language.value,
        });
      }
      controller = new AbortController();
      controls();
      status.textContent =
        "Uploading to this server… You can stop this attempt.";
      let saved;
      try {
        saved = await upload(attempt, controller.signal);
        if (
          saved.request_id !== attempt.id ||
          !/^[0-9a-f-]{36}$/i.test(saved.id) ||
          !["active", "expired", "deleted", "revoked"].includes(saved.state) ||
          !Number.isFinite(saved.expiresAt)
        )
          throw new Error("Unconfirmed upload response");
      } catch (error) {
        status.textContent = controller.signal.aborted
          ? "Upload stopped. Storage may have committed; check saved audio or retry this same upload."
          : error.status === 401 || error.status === 403
            ? "This workspace is unavailable or expired. Refresh the page to start again. Earlier clips keep their existing expiry."
            : error.status === 422
              ? "Clip rejected. Use a supported PCM16 WAV. Check saved audio and clear the selection to choose another file."
              : "Could not confirm this upload. Retry this same upload or check saved audio before clearing the selection.";
        throw new Error(status.textContent);
      } finally {
        controller = null;
        controls();
      }
      reset();
      const message =
        saved.state === "active"
          ? `Clip saved. Access expires ${new Date(saved.expiresAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Processing consent recorded: ${saved.consentToProcess ? "yes" : "no"}. Upload does not start speech processing.`
          : `This request is already recorded as ${saved.state}. The clip was not stored again.`;
      status.textContent = message;
      try {
        await refresh();
      } catch {
        status.textContent = `${message} Saved audio could not be refreshed; use Refresh saved media.`;
      }
    }, file);
  });
  return {
    setBusy(value) {
      busy = value;
      controls();
    },
    async initialize() {
      enabled = false;
      panel.hidden = true;
      reset();
      try {
        const health = await api("/health");
        enabled =
          health.local_media_uploads === true &&
          health.local_media_controls === true &&
          health.public_demo === false;
        panel.hidden = !enabled;
        controls();
      } catch {
        /* Upload-only failure leaves the rest of the workspace available. */
      }
    },
  };
}
