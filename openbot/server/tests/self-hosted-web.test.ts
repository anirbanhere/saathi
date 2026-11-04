import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { SelfHostedStore } from "../src/self-hosted/store";
import { attachSelfHostedWeb } from "../src/self-hosted/web";

test("the console serves only its fixed assets with local security headers", async () => {
  const folder = mkdtempSync(join(tmpdir(), "saathi-web-"));
  if (
    dirname(resolve(folder)) !== resolve(tmpdir()) ||
    !basename(folder).startsWith("saathi-web-")
  )
    throw new Error("Refuse cleanup outside the named test directory.");
  const store = new SelfHostedStore(join(folder, "state.sqlite"));
  try {
    const app = attachSelfHostedWeb(
      createSelfHostedApp({
        store,
        model: "synthetic:free",
        answer: async () => "synthetic",
      }),
    );
    const page = await app.request("http://localhost:8790/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("SELF-HOSTED STORAGE");
    expect(html).toContain('id="text-export"');
    expect(html).toContain('id="help-show"');
    expect(html).toContain("not a full account backup");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(
      (await app.request("http://localhost:8790/assets/app.js")).status,
    ).toBe(200);
    expect(
      (await app.request("http://localhost:8790/assets/plans.js")).status,
    ).toBe(200);
    const help = await app.request("http://localhost:8790/assets/help.js");
    expect(help.status).toBe(200);
    expect(await help.text()).toContain("createHelpConsole");
    const download = await app.request(
      "http://localhost:8790/assets/export.js",
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toContain("downloadTextExport");
    const media = await app.request("http://localhost:8790/assets/media.js");
    expect(media.status).toBe(200);
    expect(await media.text()).toContain("createMediaConsole");
    const upload = await app.request("http://localhost:8790/assets/upload.js");
    expect(upload.status).toBe(200);
    expect(await upload.text()).toContain("createAudioUpload");
    const fixture = await app.request(
      "http://localhost:8790/assets/fixture.js",
    );
    expect(fixture.status).toBe(200);
    expect(await fixture.text()).toContain("createFixtureConsole");
    expect(
      (await app.request("http://localhost:8790/assets/.env")).status,
    ).toBe(404);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
