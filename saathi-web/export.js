class TextDownloadError extends Error {}
const unconfirmed = () =>
  new TextDownloadError(
    "Text download was not confirmed. Try again explicitly; no automatic retry was made.",
  );

// Explicit click only. A server response cannot confirm that the browser saved a file.
export async function downloadTextExport(csrf) {
  if (typeof csrf !== "string" || !csrf)
    throw new TextDownloadError("Start a workspace before downloading text.");
  const controller = new AbortController();
  let timer, url, anchor;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(unconfirmed());
    }, 20000);
  });
  const read = async () => {
    const response = await fetch("/api/text-export", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Saathi-CSRF": csrf },
      body: JSON.stringify({ scope: "conversations_and_reviewed_preferences" }),
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw unconfirmed();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const messages = {
        401: "Your workspace session expired. Start a new workspace before downloading text.",
        403: "Text download was refused. Refresh this page before trying again.",
        404: "Text download is unavailable on this server version.",
        405: "Text download is unavailable on this server version.",
        413: "Text download exceeds the demo's size limit. No file was created.",
        429: "Text download request limit reached. Try again explicitly later.",
      };
      throw new TextDownloadError(
        messages[response.status] ??
          "Text download is unavailable. Try again explicitly later.",
      );
    }
    const declared = response.headers.get("content-length");
    if (
      response.headers.get("content-type")?.split(";")[0].trim() !==
        "application/json" ||
      (declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > 2000000))
    ) {
      void response.body?.cancel().catch(() => {});
      throw new TextDownloadError(
        "Text download returned an unsupported file.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw unconfirmed();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        if (controller.signal.aborted) throw unconfirmed();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2000000) {
          cancel();
          throw new TextDownloadError(
            "Text download exceeds the demo's size limit. No file was created.",
          );
        }
        chunks.push(value);
      }
      if (controller.signal.aborted) throw unconfirmed();
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      data?.format !== "saathi-text-export-v1" ||
      data.scope !== "conversations_and_reviewed_preferences" ||
      data.complete_for_scope !== true ||
      !Array.isArray(data.threads) ||
      !Array.isArray(data.memories)
    )
      throw new TextDownloadError(
        "Text download returned an unsupported file.",
      );
    return new Blob([bytes], { type: "application/json" });
  };
  try {
    const blob = await Promise.race([read(), stopped]);
    if (controller.signal.aborted) throw unconfirmed();
    url = URL.createObjectURL(blob);
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "saathi-text-export.json";
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    const completedUrl = url;
    // Give the native downloader time to consume the URL; document unload also releases it.
    setTimeout(() => URL.revokeObjectURL(completedUrl), 30000);
    url = null;
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    throw error instanceof TextDownloadError ? error : unconfirmed();
  } finally {
    anchor?.remove();
    clearTimeout(timer);
    controller.abort();
  }
}
