import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { migrateSttAdmissions } from "../src/self-hosted/stt-admission";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  checks: Database[] = [];
const role = (provider = "fixture-a") =>
  selfHostedConfig({ SAATHI_STT_PROVIDER: provider }).roles.stt;
const inspect = (path: string) => {
  const db = new Database(path);
  checks.push(db);
  return db;
};
function world(profile = role()) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-claims-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  let now = Date.now();
  const open = () => {
    const store = new SelfHostedStore(path, { now: () => now });
    stores.push(store);
    return store;
  };
  const store = open(),
    a = store.createSession(),
    b = store.createSession();
  const media = store.media.admit(a.owner, {
    request_id: "clip",
    audio: syntheticSpeechFixture("en-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "en-IN",
  });
  const input = (request_id = "request") => ({
    request_id,
    media_id: media.id,
    consent_revision: media.consentRevision,
  });
  const admission = store.sttAdmissions.begin(a.owner, input(), profile);
  return {
    store,
    path,
    open,
    a,
    b,
    media,
    input,
    admission,
    profile,
    now: () => now,
    clock: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => {
  for (const db of checks.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-claims-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(folder, { recursive: true, force: true });
  }
});

test("one-shot fixture claim returns audio/token once and status stores/exposes no raw executor credential", () => {
  const w = world(),
    claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  expect(claim.fresh).toBe(true);
  if (!claim.fresh) throw new Error("Expected synthetic claim");
  expect(claim.audio).toEqual(syntheticSpeechFixture("en-IN").audio);
  expect(claim.executorToken).toHaveLength(43);
  expect(JSON.stringify(claim)).not.toContain(claim.executorToken);
  expect(JSON.stringify(claim)).not.toContain('"audio"');
  expect(claim.admission.state).toBe("claimed");
  expect(claim.admission.pending).toBe(true);
  claim.audio[0] = 0;
  expect(w.store.media.read(w.a.owner, w.media.id)[0]).toBe(82);
  const duplicate = w.store.sttAdmissions.claim(
    w.a.owner,
    w.admission.id,
    role("disabled"),
  );
  expect(duplicate.fresh).toBe(false);
  expect(JSON.stringify(duplicate)).not.toContain("executorToken");
  expect(JSON.stringify(duplicate)).not.toContain('"audio"');
  const status = w.store.sttAdmissions.get(w.a.owner, w.admission.id);
  expect(JSON.stringify(status)).not.toContain(claim.executorToken);
  const saved = inspect(w.path)
    .query<{ claim_hash: string }, [string]>(
      "SELECT claim_hash FROM stt_admissions WHERE id=?",
    )
    .get(w.admission.id);
  expect(saved?.claim_hash).toBe(
    createHash("sha256").update(claim.executorToken).digest("hex"),
  );
  expect(() =>
    w.store.sttAdmissions.claim(w.b.owner, w.admission.id, role()),
  ).toThrow("not found");
});

test("changed role policy, revoked/expired consent and corrupt media fail closed without returning claims", () => {
  const changed = world();
  const denied = changed.store.sttAdmissions.claim(
    changed.a.owner,
    changed.admission.id,
    role("fixture-b"),
  );
  expect(denied.fresh).toBe(false);
  expect(denied.admission.state).toBe("blocked");
  expect(denied.admission.pending).toBe(false);
  expect(
    changed.store.sttAdmissions.claim(
      changed.a.owner,
      changed.admission.id,
      role(),
    ).fresh,
  ).toBe(false);
  const revoked = world();
  revoked.store.media.revokeProcessing(revoked.a.owner, revoked.media.id);
  const stopped = revoked.store.sttAdmissions.claim(
    revoked.a.owner,
    revoked.admission.id,
    role(),
  );
  expect(stopped.fresh).toBe(false);
  expect(stopped.admission.pending).toBe(false);
  const expired = world();
  expired.clock(expired.media.expiresAt);
  expect(
    expired.store.sttAdmissions.claim(
      expired.a.owner,
      expired.admission.id,
      role(),
    ).fresh,
  ).toBe(false);
  const corrupt = world();
  inspect(corrupt.path)
    .query("UPDATE owned_media SET audio=? WHERE id=?")
    .run(new Uint8Array(8044), corrupt.media.id);
  expect(
    corrupt.store.sttAdmissions.claim(
      corrupt.a.owner,
      corrupt.admission.id,
      role(),
    ).fresh,
  ).toBe(false);
});

test("cancelling a claimed task holds its slot until exclusive restart and never reissues audio/token", () => {
  const w = world();
  w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  const cancelled = w.store.sttAdmissions.cancel(w.a.owner, w.admission.id);
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.pending).toBe(true);
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input("another"), role()),
  ).toThrow("pending");
  expect(
    w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  w.store.close();
  const reopened = w.open();
  expect(reopened.sttAdmissions.get(w.a.owner, w.admission.id).pending).toBe(
    false,
  );
  expect(reopened.sttAdmissions.get(w.a.owner, w.admission.id).state).toBe(
    "cancelled",
  );
  expect(
    reopened.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  expect(
    inspect(w.path)
      .query<{ claim_hash: string | null }, [string]>(
        "SELECT claim_hash FROM stt_admissions WHERE id=?",
      )
      .get(w.admission.id)?.claim_hash,
  ).toBeNull();
  expect(
    reopened.sttAdmissions.begin(w.a.owner, w.input("another"), role()).state,
  ).toBe("reserved");
});

test("claim deadline clamps to the current session expiry and revocation retains only an in-flight slot", () => {
  const w = world();
  inspect(w.path)
    .query("UPDATE sessions SET expires=? WHERE owner=?")
    .run(w.now() + 500, w.a.owner);
  const claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  expect(claim.admission.claimDeadline).toBe(w.now() + 500);
  w.store.media.revoke(w.a.owner, w.media.id);
  const status = w.store.sttAdmissions.get(w.a.owner, w.admission.id);
  expect(status.state).toBe("revoked");
  expect(status.pending).toBe(true);
});

test("real v10 migration preserves reservations/unit ledger and interrupts old pending work without replay", () => {
  const w = world();
  w.store.close();
  const fixture = inspect(w.path);
  const columns =
    "id,owner,request,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires";
  fixture.exec(
    `DROP TRIGGER IF EXISTS media_invalidates_stt; CREATE TEMP TABLE admission_copy AS SELECT ${columns} FROM stt_admissions; DROP TABLE stt_admissions`,
  );
  migrateSttAdmissions(fixture);
  fixture.exec(
    `INSERT INTO stt_admissions SELECT ${columns} FROM admission_copy; DROP TABLE admission_copy; DROP TABLE stt_budget_holds; UPDATE version SET value=10`,
  );
  const migrated = w.open();
  expect(migrated.sttAdmissions.get(w.a.owner, w.admission.id).state).toBe(
    "interrupted",
  );
  expect(
    migrated.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  expect(
    fixture
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(1);
  expect(migrated.media.metadata(w.a.owner, w.media.id)).toEqual(w.media);
});

const outcome = () => ({
  status: "completed",
  transcript: {
    text: syntheticSpeechFixture("en-IN").text,
    language: "en-IN",
    confidence: null,
    alternatives: [],
    warnings: ["Synthetic tone lookup only."],
    source: {
      mode: "fixture",
      provider: "fixture-a",
      model: "synthetic-stt-v1",
    },
  },
});
test("private executor settlement authenticates before parsing, preserves duplicates and never exposes its token/hash", () => {
  const w = world(),
    claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  if (!claim.fresh) throw new Error("Expected synthetic claim");
  expect(() =>
    w.store.sttAdmissions.settle(w.a.owner, w.admission.id, "x".repeat(43), {
      get status() {
        throw new Error("Must authenticate first");
      },
    }),
  ).toThrow("executor");
  expect(() =>
    w.store.sttAdmissions.settle(
      w.b.owner,
      w.admission.id,
      claim.executorToken,
      outcome(),
    ),
  ).toThrow("not found");
  const settled = w.store.sttAdmissions.settle(
    w.a.owner,
    w.admission.id,
    claim.executorToken,
    outcome(),
  );
  expect(settled.state).toBe("completed");
  expect(settled.pending).toBe(false);
  expect(settled.outcome?.status).toBe("completed");
  expect(JSON.stringify(settled)).not.toContain(claim.executorToken);
  expect(JSON.stringify(settled)).not.toContain("claim_hash");
  w.clock(w.now() + 1000);
  expect(
    w.store.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      outcome(),
    ),
  ).toEqual(settled);
  expect(() =>
    w.store.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      { status: "failed", code: "provider_failed" },
    ),
  ).toThrow("conflicts");
  expect(
    w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  w.store.close();
  const reopened = w.open();
  expect(reopened.sttAdmissions.get(w.a.owner, w.admission.id)).toEqual(
    settled,
  );
  expect(
    reopened.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      outcome(),
    ),
  ).toEqual(settled);
});

test("late cancelled/revoked outcomes release pending slots without retaining transcript text or replaying", () => {
  for (const stop of ["cancel", "revoke"] as const) {
    const w = world(),
      claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
    if (!claim.fresh) throw new Error("Expected claim");
    if (stop === "cancel")
      w.store.sttAdmissions.cancel(w.a.owner, w.admission.id);
    else w.store.media.revokeProcessing(w.a.owner, w.media.id);
    expect(w.store.sttAdmissions.get(w.a.owner, w.admission.id).pending).toBe(
      true,
    );
    const settled = w.store.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      outcome(),
    );
    expect(settled.state).toBe(stop === "cancel" ? "cancelled" : "revoked");
    expect(settled.pending).toBe(false);
    expect(settled.outcome).toBeNull();
    expect(
      inspect(w.path)
        .query<{ outcome: string | null }, [string]>(
          "SELECT outcome FROM stt_admissions WHERE id=?",
        )
        .get(w.admission.id)?.outcome,
    ).toBeNull();
    expect(
      w.store.sttAdmissions.settle(
        w.a.owner,
        w.admission.id,
        claim.executorToken,
        outcome(),
      ),
    ).toEqual(settled);
    expect(
      w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
    ).toBe(false);
  }
});

test("executor tokens are scoped per admission and failures persist fixed codes rather than raw provider payloads", () => {
  const w = world(),
    first = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  if (!first.fresh) throw new Error("Expected claim");
  w.store.sttAdmissions.settle(
    w.a.owner,
    w.admission.id,
    first.executorToken,
    outcome(),
  );
  const next = w.store.sttAdmissions.begin(
      w.a.owner,
      w.input("failed-request"),
      role(),
    ),
    second = w.store.sttAdmissions.claim(w.a.owner, next.id, role());
  if (!second.fresh) throw new Error("Expected second claim");
  expect(() =>
    w.store.sttAdmissions.settle(w.a.owner, next.id, first.executorToken, {
      status: "failed",
      code: "provider_failed",
    }),
  ).toThrow("executor");
  expect(() =>
    w.store.sttAdmissions.settle(w.a.owner, next.id, second.executorToken, {
      status: "failed",
      code: "provider_failed",
      raw_error: "synthetic-private-provider-body",
    }),
  ).toThrow();
  const failed = w.store.sttAdmissions.settle(
    w.a.owner,
    next.id,
    second.executorToken,
    { status: "failed", code: "provider_failed" },
  );
  expect(failed.state).toBe("failed");
  expect(failed.pending).toBe(false);
  expect(failed.outcome).toEqual({ status: "failed", code: "provider_failed" });
  expect(JSON.stringify(failed)).not.toContain("synthetic-private");
});

test("stored fixture text is hidden on expiry and atomically cleared by media revocation/deletion/explicit purge", () => {
  for (const action of ["revoke", "remove", "expire"] as const) {
    const w = world(),
      claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
    if (!claim.fresh) throw new Error("Expected claim");
    w.store.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      outcome(),
    );
    if (action === "revoke")
      w.store.media.revokeProcessing(w.a.owner, w.media.id);
    else if (action === "remove") w.store.media.remove(w.a.owner, w.media.id);
    else {
      w.clock(w.media.expiresAt);
      expect(
        w.store.sttAdmissions.get(w.a.owner, w.admission.id).outcome,
      ).toBeNull();
      w.store.media.purgeExpired();
    }
    expect(
      w.store.sttAdmissions.get(w.a.owner, w.admission.id).outcome,
    ).toBeNull();
    expect(
      inspect(w.path)
        .query<{ outcome: string | null }, [string]>(
          "SELECT outcome FROM stt_admissions WHERE id=?",
        )
        .get(w.admission.id)?.outcome,
    ).toBeNull();
    expect(() =>
      w.store.sttAdmissions.settle(
        w.a.owner,
        w.admission.id,
        claim.executorToken,
        outcome(),
      ),
    ).toThrow("executor");
  }
});

test("deadline and expired user session discard late text while allowing the private worker to release its slot", () => {
  const w = world({ ...role(), timeoutMs: 1000 }),
    claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, w.profile);
  if (!claim.fresh) throw new Error("Expected claim");
  w.clock((claim.admission.claimDeadline ?? 0) + 1);
  const late = w.store.sttAdmissions.settle(
    w.a.owner,
    w.admission.id,
    claim.executorToken,
    outcome(),
  );
  expect(late.state).toBe("failed");
  expect(late.outcome).toEqual({ status: "failed", code: "timeout" });
  expect(late.pending).toBe(false);
  const expired = world();
  inspect(expired.path)
    .query("UPDATE sessions SET expires=? WHERE owner=?")
    .run(expired.now() + 500, expired.a.owner);
  const sessionClaim = expired.store.sttAdmissions.claim(
    expired.a.owner,
    expired.admission.id,
    role(),
  );
  if (!sessionClaim.fresh) throw new Error("Expected claim");
  expired.clock(expired.now() + 501);
  const result = expired.store.sttAdmissions.settle(
    expired.a.owner,
    expired.admission.id,
    sessionClaim.executorToken,
    outcome(),
  );
  expect(result.pending).toBe(false);
  expect(result.outcome).toBeNull();
  expect(() =>
    expired.store.sttAdmissions.get(expired.a.owner, expired.admission.id),
  ).toThrow("session");
});

test("restart invalidates a claimed executor token, and malformed evidence cannot release a live slot", () => {
  const w = world(),
    claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  if (!claim.fresh) throw new Error("Expected claim");
  expect(() =>
    w.store.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      {
        ...outcome(),
        transcript: {
          ...outcome().transcript,
          source: { ...outcome().transcript.source, mode: "live" },
        },
      },
    ),
  ).toThrow();
  expect(w.store.sttAdmissions.get(w.a.owner, w.admission.id).pending).toBe(
    true,
  );
  const enormous = {
    ...outcome(),
    transcript: {
      ...outcome().transcript,
      text: `a${"\u0000".repeat(1998)}b`,
      alternatives: [
        "\u0000".repeat(2000),
        "\u0000".repeat(2000),
        "\u0000".repeat(2000),
      ],
    },
  };
  expect(() =>
    w.store.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      enormous,
    ),
  ).toThrow("budget");
  w.store.close();
  const reopened = w.open();
  expect(reopened.sttAdmissions.get(w.a.owner, w.admission.id).state).toBe(
    "interrupted",
  );
  expect(() =>
    reopened.sttAdmissions.settle(
      w.a.owner,
      w.admission.id,
      claim.executorToken,
      outcome(),
    ),
  ).toThrow("executor");
  expect(
    reopened.sttAdmissions.get(w.a.owner, w.admission.id).outcome,
  ).toBeNull();
});

test("media/history transaction failure rolls back retained outcome invalidation", () => {
  const w = world(),
    claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  if (!claim.fresh) throw new Error("Expected claim");
  const settled = w.store.sttAdmissions.settle(
    w.a.owner,
    w.admission.id,
    claim.executorToken,
    outcome(),
  );
  inspect(w.path).exec(
    "CREATE TRIGGER synthetic_claim_history_failure BEFORE INSERT ON media_consent_events BEGIN SELECT RAISE(ABORT,'Synthetic history failure'); END",
  );
  expect(() => w.store.media.revokeProcessing(w.a.owner, w.media.id)).toThrow();
  expect(w.store.sttAdmissions.get(w.a.owner, w.admission.id)).toEqual(settled);
  expect(w.store.media.metadata(w.a.owner, w.media.id).consentToProcess).toBe(
    true,
  );
});

test("separate processes can hand out claim audio/token only once; a lost worker never replays after restart", async () => {
  const w = world(),
    children = [0, 1].map(() =>
      Bun.spawn(
        [
          process.execPath,
          resolve(
            import.meta.dir,
            "fixtures/self-hosted-stt-claim-contender.ts",
          ),
          w.path,
          w.a.owner,
          w.admission.id,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      ),
    );
  try {
    await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader(),
          first = await reader.read();
        reader.releaseLock();
        expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
      }),
    );
    for (const child of children) {
      child.stdin.write("go\n");
      child.stdin.end();
    }
    const results = await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader(),
          decoder = new TextDecoder();
        let output = "";
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            output += decoder.decode(part.value, { stream: true });
          }
          output += decoder.decode();
        } finally {
          reader.releaseLock();
        }
        expect(await child.exited).toBe(0);
        return JSON.parse(output) as {
          fresh: boolean;
          audioReturned: boolean;
          tokenReturned: boolean;
        };
      }),
    );
    expect(results.filter((result) => result.fresh)).toHaveLength(1);
    expect(results.filter((result) => result.audioReturned)).toHaveLength(1);
    expect(results.filter((result) => result.tokenReturned)).toHaveLength(1);
    expect(w.store.sttAdmissions.get(w.a.owner, w.admission.id).pending).toBe(
      true,
    );
    w.store.close();
    const recovered = w.open();
    expect(recovered.sttAdmissions.get(w.a.owner, w.admission.id).state).toBe(
      "interrupted",
    );
    expect(
      recovered.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
    ).toBe(false);
    expect(
      inspect(w.path)
        .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
        .get()?.n,
    ).toBe(1);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}, 15000);
