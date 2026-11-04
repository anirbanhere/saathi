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

// Installs an explicit control only; entering or refreshing the workspace never reads help.
export function createHelpConsole({ api, run }) {
  const language = document.querySelector("#help-locale");
  const show = document.querySelector("#help-show");
  const output = document.querySelector("#help-output");
  let busy = false;
  show.addEventListener("click", () => {
    if (busy) return;
    const locale = language.value;
    const valid = Object.hasOwn(phrases, locale);
    const words = phrases[valid ? locale : "en-IN"];
    run(
      async () => {
        const controller = new AbortController();
        let timer;
        output.textContent = "";
        output.lang = valid ? locale : "en-IN";
        try {
          if (!valid) throw new Error("Unsupported help locale");
          const stopped = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Help deadline"));
            }, 20000);
          });
          const result = await Promise.race([
            api(
              "/api/control-read",
              { intent: "help", locale },
              "POST",
              controller.signal,
            ),
            stopped,
          ]);
          if (
            controller.signal.aborted ||
            result?.format !== "saathi-control-read-v1" ||
            result.intent !== "help" ||
            result.locale !== locale ||
            result.action_executed !== false ||
            typeof result.message !== "string" ||
            !result.message.trim() ||
            result.message.length > 6000
          )
            throw new Error("Unsupported help response");
          output.textContent = result.message;
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
  });
  return {
    setBusy(value) {
      busy = Boolean(value);
      language.disabled = busy;
      show.disabled = busy;
    },
  };
}
