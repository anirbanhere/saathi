const phrases = {
  "en-IN": [
    "Help loaded. No task was run.",
    "Help could not be loaded. Try again explicitly.",
    "Your session expired. Start a new workspace to load help.",
  ],
  "hi-IN": [
    "मदद लोड हुई। कोई कार्य नहीं चलाया गया।",
    "मदद लोड नहीं हो सकी। अपनी इच्छा से दोबारा कोशिश करें।",
    "सत्र समाप्त हो गया। मदद के लिए नया कार्यक्षेत्र शुरू करें।",
  ],
  "ta-IN": [
    "உதவி ஏற்றப்பட்டது. எந்தப் பணியும் இயக்கப்படவில்லை.",
    "உதவியை ஏற்ற முடியவில்லை. நீங்களே மீண்டும் முயற்சிக்கவும்.",
    "அமர்வு காலாவதியானது. உதவியைப் பார்க்க புதிய பணியிடத்தைத் தொடங்கவும்.",
  ],
};

const statusPhrases = {
  "en-IN": [
    "Status checked. No task was run.",
    "Status could not be loaded. Try again explicitly.",
    "Your session expired. Start a new workspace to read status.",
    "Saved-state snapshot",
  ],
  "hi-IN": [
    "स्थिति पढ़ी गई। कोई कार्य नहीं चलाया गया।",
    "स्थिति नहीं पढ़ी जा सकी। अपनी इच्छा से दोबारा कोशिश करें।",
    "सत्र समाप्त हो गया। स्थिति के लिए नया कार्यक्षेत्र शुरू करें।",
    "सहेजी स्थिति का स्नैपशॉट",
  ],
  "ta-IN": [
    "நிலை சரிபார்க்கப்பட்டது. எந்தப் பணியும் இயக்கப்படவில்லை.",
    "நிலையை ஏற்ற முடியவில்லை. நீங்களே மீண்டும் முயற்சிக்கவும்.",
    "அமர்வு காலாவதியானது. நிலையைப் பார்க்க புதிய பணியிடத்தைத் தொடங்கவும்.",
    "சேமித்த நிலையின் பதிவு",
  ],
};
const statusCodes = {
  demo_appointment: [
    "select_slot",
    "review_approval",
    "mock_confirmed",
    "rejected",
    "cancelled",
    "approval_expired",
    "unavailable",
  ],
  task_plan: [
    "planning",
    "draft_ready",
    "needs_clarification",
    "unavailable",
    "failed",
    "interrupted",
    "cancelled",
  ],
};
const textWithin = (text, limit) =>
  typeof text === "string" && text.trim().length > 0 && text.length <= limit;

// Installs explicit controls only; creating/rendering cards never requests a read.
export function createHelpConsole({ api, run, el }) {
  const language = document.querySelector("#help-locale");
  const show = document.querySelector("#help-show");
  const helpOutput = document.querySelector("#help-output");
  let busy = false;
  function read(intent, target, output) {
    if (busy) return;
    const locale = language.value;
    const valid = Object.hasOwn(phrases, locale);
    const words = (intent === "help" ? phrases : statusPhrases)[
      valid ? locale : "en-IN"
    ];
    run(
      async () => {
        const controller = new AbortController();
        let timer;
        output.textContent = "";
        output.lang = valid ? locale : "en-IN";
        try {
          if (!valid) throw new Error("Unsupported control locale");
          const stopped = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Control deadline"));
            }, 20000);
          });
          const result = await Promise.race([
            api(
              "/api/control-read",
              { intent, locale, ...(target ? { target } : {}) },
              "POST",
              controller.signal,
            ),
            stopped,
          ]);
          if (
            controller.signal.aborted ||
            result?.format !== "saathi-control-read-v1" ||
            result.intent !== intent ||
            result.locale !== locale ||
            result.action_executed !== false ||
            !textWithin(result.message, 6000)
          )
            throw new Error("Unsupported control response");
          if (intent === "help") output.textContent = result.message;
          else {
            const state = result.status;
            if (
              result.target?.kind !== target.kind ||
              result.target.id !== target.id ||
              result.evidence_scope !== "stored_task_metadata" ||
              state?.mode !==
                (target.kind === "task_plan" ? "draft_only" : "mock") ||
              !statusCodes[target.kind].includes(state.code) ||
              !textWithin(state.stored_state, 32) ||
              typeof state.pending !== "boolean" ||
              !textWithin(result.notice, 2000) ||
              (state.pending
                ? !textWithin(result.pending_note, 2000)
                : result.pending_note !== null) ||
              !Number.isSafeInteger(result.observed_at) ||
              result.observed_at < 0 ||
              !Number.isFinite(new Date(result.observed_at).valueOf())
            )
              throw new Error("Unsupported status metadata");
            const stamp = new Date(result.observed_at).toLocaleString(locale, {
              timeZone: "Asia/Kolkata",
            });
            output.textContent = [
              words[3] + " · " + stamp + " IST",
              result.message,
              result.notice,
              result.pending_note,
            ]
              .filter(Boolean)
              .join("\n\n");
          }
        } catch (error) {
          const message = error?.status === 401 ? words[2] : words[1];
          output.textContent = message;
          output.focus();
          throw new Error(message);
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      },
      output,
      words[0],
    );
  }
  show.addEventListener("click", () => read("help", null, helpOutput));
  return {
    setBusy(value) {
      busy = Boolean(value);
      language.disabled = busy;
      show.disabled = busy;
    },
    statusControl(kind, id, label) {
      if (
        !Object.hasOwn(statusCodes, kind) ||
        typeof id !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
      )
        return el("p", "Saved status is unavailable for this item.");
      const target = Object.freeze({ kind, id });
      const container = el("div"),
        button = el("button", "Read saved status"),
        output = el("p");
      button.type = "button";
      button.className = "secondary";
      button.disabled = busy;
      button.setAttribute(
        "aria-label",
        `Read saved status: ${typeof label === "string" ? label.slice(0, 120) : "this task"}`,
      );
      output.className = "notice control-readout";
      output.setAttribute("role", "status");
      output.setAttribute("aria-live", "polite");
      output.setAttribute("tabindex", "-1");
      button.addEventListener("click", () => read("status", target, output));
      container.append(button, output);
      return container;
    },
  };
}
