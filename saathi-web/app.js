import { createAppointmentConsole } from "./appointments.js";
import { createFixtureConsole } from "./fixture.js";
import { createMediaConsole } from "./media.js";
import { createPlanConsole } from "./plans.js";
import { createAudioUpload } from "./upload.js";

const $ = (selector) => document.querySelector(selector);
const el = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
let csrf = "",
  selected = null,
  busy = false,
  pending = null,
  lastModel = null;
const demoAppointments = createAppointmentConsole({ api, run, el, button });
const taskPlans = createPlanConsole({ api, run, el, button });
const savedMedia = createMediaConsole({
  api,
  run,
  el,
  button,
  onPrivacyChange: () => fixtureSpeech.privacyChanged(),
});
const fixtureSpeech = createFixtureConsole({ api, run, el, button });
const audioUpload = createAudioUpload({
  api,
  run,
  upload: uploadAudio,
  refresh: savedMedia.refresh,
});
async function uploadAudio(attempt, signal) {
  const response = await fetch("/api/media/upload", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "audio/wav",
      "X-Saathi-CSRF": csrf,
      "X-Saathi-Request-ID": attempt.id,
      "X-Saathi-Consent-Store": "true",
      "X-Saathi-Consent-Process": String(attempt.process),
      ...(attempt.language ? { "X-Saathi-Language": attempt.language } : {}),
    },
    body: attempt.file,
  });
  if (!response.ok) {
    const error = new Error("Upload response was not confirmed.");
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function api(path, body, method = "POST", signal) {
  const response = await fetch(
    path,
    body === undefined
      ? { signal }
      : {
          method,
          signal,
          headers: {
            "Content-Type": "application/json",
            "X-Saathi-CSRF": csrf,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      result.error?.message ||
        "Request failed. Refresh saved state before retrying.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
async function run(action, focusAfter = null) {
  if (busy) return;
  busy = true;
  demoAppointments.setBusy(true);
  taskPlans.setBusy(true);
  savedMedia.setBusy(true);
  audioUpload.setBusy(true);
  fixtureSpeech.setBusy(true);
  $("#model-select").disabled = true;
  $("#message").readOnly = true;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  $("#status").textContent = "Working…";
  let succeeded = false;
  try {
    await action();
    succeeded = true;
    $("#status").textContent = "Saved on this server.";
  } catch (error) {
    $("#status").textContent = error.message;
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
    $("#send").textContent = pending
      ? "Check previous send ↗"
      : "Send message ↗";
    $("#model-select").disabled = Boolean(pending);
    $("#message").readOnly = Boolean(pending);
    $("#send").disabled = !pending && !$("#model-select").value;
    demoAppointments.setBusy(false);
    taskPlans.setBusy(false);
    savedMedia.setBusy(false);
    audioUpload.setBusy(false);
    fixtureSpeech.setBusy(false);
    if (succeeded) focusAfter?.focus();
  }
}
function button(text, action, className = "secondary", focusAfter = null) {
  const element = el("button", text);
  element.type = "button";
  element.className = className;
  element.addEventListener("click", () => run(action, focusAfter));
  return element;
}
async function threads() {
  const records = await api("/api/threads"),
    list = $("#threads");
  list.replaceChildren();
  for (const record of records) {
    const title = `${record.agent === "saathi" ? "Everyday help" : record.agent} · ${new Date(record.created).toLocaleDateString("en-IN")}`;
    const item = button(
      title,
      async () => {
        pending = null;
        await show(record.id);
        await threads();
      },
      "thread",
    );
    item.setAttribute("aria-current", String(selected === record.id));
    list.append(item);
  }
  if (!records.length) list.append(el("p", "No conversations yet."));
}
async function show(id) {
  const thread = await api(`/api/threads/${id}`);
  selected = id;
  $("#delete-thread").hidden = false;
  const runState = thread.lastRun?.state;
  lastModel = thread.lastRun?.model || null;
  $("#thread-state").textContent =
    runState === "running"
      ? "An answer is still running. Refresh saved state to check it."
      : ["failed", "interrupted"].includes(runState)
        ? `Last send: ${runState}. It was not replayed. A new send is a new model request.`
        : "";
  if (thread.lastRun)
    $("#thread-state").textContent +=
      ` Last model: ${thread.lastRun.model || "unknown (historical run)"}.`;
  $("#thread-title").textContent =
    thread.agent === "saathi"
      ? "Everyday help"
      : thread.agent === "kitchen"
        ? "Saathi Kitchen"
        : "Saathi Stock";
  const list = $("#messages");
  list.replaceChildren();
  for (const message of thread.messages) {
    const card = el("article");
    card.className = `message ${message.role}`;
    const speaker = el("span", message.role === "user" ? "You" : "Saathi");
    speaker.className = "speaker";
    card.append(speaker, el("span", message.content));
    if (message.evidence?.sources?.length) {
      const evidence = el("div");
      evidence.className = "sources";
      evidence.append(
        el(
          "p",
          `Web sources · retrieved ${new Date(message.evidence.searchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Check source publication and validity dates.`,
        ),
      );
      for (const source of message.evidence.sources) {
        try {
          const url = new URL(source.url);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            !url.hostname.includes(".") ||
            /[:[\]]/.test(url.hostname) ||
            /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
            /\.(local|localhost|internal|test|invalid)$/.test(url.hostname)
          )
            continue;
          const label =
            source.kind === "opened_page"
              ? "Page opened"
              : source.kind === "search_result"
                ? "Search result"
                : "Cited source";
          const link = el("a", `${label}: ${source.title} · ${url.pathname}`);
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          evidence.append(link, el("br"));
        } catch {}
      }
      card.append(evidence);
    }
    list.append(card);
  }
  if (!thread.messages.length)
    list.append(
      el(
        "p",
        "Start with a question. This conversation will stay here after a server restart.",
      ),
    );
  list.scrollTop = list.scrollHeight;
}
async function memories() {
  const records = await api("/api/memories"),
    list = $("#memories");
  list.replaceChildren();
  for (const record of records) {
    const card = el("article");
    card.className = "memory-item";
    card.append(
      el("p", record.content),
      button(
        "Delete memory",
        async () => {
          await api(`/api/memories/${record.id}`, {}, "DELETE");
          await memories();
          $("#memory-text").focus();
        },
        "text-button",
      ),
    );
    list.append(card);
  }
  if (!records.length) list.append(el("p", "No memories saved."));
}
async function models() {
  const data = await api("/api/models"),
    picker = $("#model-select");
  const previous =
    pending?.model || picker.value || lastModel || data.defaultModel;
  picker.replaceChildren();
  const empty = el("option", "Choose a reply model");
  empty.value = "";
  picker.append(empty);
  for (const model of data.models) {
    const cost =
      model.provider === "meta"
        ? "Meta · billing/credits unverified"
        : `$${model.inputPerMillion} input / $${model.outputPerMillion} output per 1M tokens`;
    const option = el(
      "option",
      `${model.name} · ${model.webSearch ? "Web lookup" : "Text only"} · ${cost}`,
    );
    option.value = model.id;
    picker.append(option);
  }
  if (pending && !data.models.some((model) => model.id === pending.model)) {
    const saved = el("option", `${pending.model} · reconcile previous send`);
    saved.value = pending.model;
    picker.append(saved);
  }
  if ([...picker.options].some((option) => option.value === previous))
    picker.value = previous;
  picker.disabled = Boolean(pending);
  $("#model-policy").textContent =
    `${data.allowPaid ? `OpenRouter rate ceilings: $${data.maxInputPrice} input / $${data.maxOutputPrice} output per 1M tokens.` : "OpenRouter is free-only."} ${data.metaEnabled ? "Meta is separately enabled; OpenRouter price ceilings do not apply to Meta." : "Meta is disabled until configured on the server."} ${data.models.length ? "Only models matching server keys and policy are listed." : "No eligible models. Configure a key or check its model permissions."} ${data.issues.join(" ")} Meta web lookups may add search charges. Prices are token rates, not a total spending limit. Language quality and capacity are unverified.`;
}
async function enter(session) {
  csrf = session.csrf;
  $("#welcome").hidden = true;
  $("#workspace").hidden = false;
  $("#model").textContent =
    "Choose a model for your next reply. Switching keeps this conversation and reviewed preferences.";
  if (session.daily_limits)
    $("#model").textContent +=
      ` Shared demo allowance: ${session.daily_limits.owner} model attempts per workspace and ${session.daily_limits.global} total per day; resets at midnight UTC.`;
  await threads();
  await memories();
  await savedMedia.initialize();
  await audioUpload.initialize();
  await fixtureSpeech.initialize();
  const records = await api("/api/threads");
  if (records.length) {
    await show(records[0].id);
    await threads();
  }
  await models();
  await demoAppointments.initialize();
  await taskPlans.initialize();
}

$("#models-refresh").addEventListener("click", () => run(models));
$("#model-select").addEventListener("change", () => {
  $("#send").disabled = !$("#model-select").value;
});
$("#start").addEventListener("click", () =>
  run(async () => enter(await api("/api/session", { consent: true }))),
);
$("#new-thread").addEventListener("click", () =>
  run(async () => {
    pending = null;
    const thread = await api("/api/threads", { agent: $("#agent").value });
    await show(thread.id);
    await threads();
    $("#message").focus();
  }),
);
$("#refresh").addEventListener("click", () =>
  run(async () => {
    if (selected) await show(selected);
    await threads();
    await memories();
    await demoAppointments.refresh();
    await taskPlans.refresh();
    await savedMedia.refresh();
  }),
);
$("#chat").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const text = $("#message").value.trim();
    if (!text) return;
    const choice = pending?.model || $("#model-select").value;
    if (!choice) throw new Error("Choose an eligible reply model first.");
    if (!selected) {
      const thread = await api("/api/threads", { agent: $("#agent").value });
      await show(thread.id);
      await threads();
    }
    if (!pending || pending.text !== text || pending.thread !== selected)
      pending = {
        id: crypto.randomUUID(),
        text,
        thread: selected,
        model: choice,
      };
    let result;
    try {
      result = await api(`/api/threads/${selected}/messages`, {
        request_id: pending.id,
        text,
        model: pending.model,
      });
    } finally {
      await show(selected);
      await threads();
    }
    if (result.state === "running")
      throw new Error(
        "This answer is still running. Refresh saved state; sending again uses the same request ID.",
      );
    if (result.state !== "completed") {
      pending = null;
      throw new Error(
        `Saved run is ${result.state}. It was not replayed. A new send is a new model request.`,
      );
    }
    pending = null;
    $("#message").value = "";
    $("#message").focus();
  });
});
$("#memory-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    await api("/api/memories", {
      content: $("#memory-text").value,
      reviewed: $("#reviewed").checked,
    });
    $("#memory-form").reset();
    await memories();
    $("#memory-text").focus();
  });
});
$("#delete-thread").addEventListener("click", () =>
  run(async () => {
    if (!selected) return;
    await api(`/api/threads/${selected}`, {}, "DELETE");
    selected = null;
    pending = null;
    $("#delete-thread").hidden = true;
    $("#messages").replaceChildren();
    $("#thread-state").textContent = "";
    $("#thread-title").textContent = "How can I help?";
    await threads();
  }, $("#new-thread")),
);
api("/api/session")
  .then(enter)
  .catch((error) => {
    if (!error.message.includes("Start a private"))
      $("#status").textContent = error.message;
  });
