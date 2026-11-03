import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import fixture from "./fixtures/stt-policy-pin.json";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  readers: Database[] = [];
afterEach(() => {
  for (const db of readers.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of folders.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith("saathi-role-record-")
    )
      throw Error("Unsafe cleanup");
    rmSync(path, { recursive: true, force: true });
  }
});
const role = () => ({
  provider: "sarvam",
  model: "saaras:v3",
  languages: ["en-IN", "hi-IN", "ta-IN"],
  timeoutMs: 20000,
});
function world(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-role-record-"));
  folders.push(dir);
  const path = join(dir, "state.sqlite"),
    at = Date.now();
  let selected: unknown = role(),
    roleCalls = 0,
    balanceCalls = 0;
  let beforeBalance: (() => void) | undefined;
  const store = new SelfHostedStore(path, {
    now: () => at,
    sttBalanceReader: (s) => {
      balanceCalls++;
      beforeBalance?.();
      return { ...s, observedAt: at, availableMicros: 100 };
    },
    sttRoleReader: enabled
      ? (scope) => {
          roleCalls++;
          expect(Object.keys(scope).sort()).toEqual([
            "accountRef",
            "ownerRef",
            "policyRevision",
            "provider",
          ]);
          return typeof selected === "function" ? selected() : selected;
        }
      : undefined,
  });
  stores.push(store);
  const db = new Database(path);
  readers.push(db);
  const profile = {
    ...structuredClone(fixture.profile),
    maxBytes: 2_000_000,
    price: {
      ...fixture.profile.price,
      model: "saaras:v3",
      effectiveAt: at - 1000,
      expiresAt: at + 60000,
    },
  };
  store.sttPolicies.register(profile);
  const owner = store.createSession().owner;
  const media = store.media.admit(owner, {
    request_id: "clip",
    audio: syntheticSpeechFixture("ta-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "ta-IN",
  });
  const input = {
    request_id: "hold",
    media_id: media.id,
    consent_revision: media.consentRevision,
    policy: {
      provider: "sarvam",
      accountRef: "synthetic-account",
      revision: "policy-v1",
    },
  };
  return {
    store,
    db,
    path,
    owner,
    media,
    input,
    profile,
    now: () => at,
    select: (r: unknown) => {
      selected = r;
    },
    beforeBalance: (fn: () => void) => {
      beforeBalance = fn;
    },
    calls: () => ({ role: roleCalls, balance: balanceCalls }),
    count: (table = "stt_hold_roles") => {
      if (!["stt_hold_roles", "stt_budget_holds"].includes(table))
        throw Error("Invalid test table");
      return db
        .query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`)
        .get()?.n;
    },
  };
}
test("a trusted role snapshot is recorded atomically with only a newly created hold", () => {
  const w = world(),
    held = w.store.sttBudgetHolds.reserve(w.owner, w.input);
  expect(held.roleBinding).toBe("recorded");
  expect(held.executionAllowed).toBe(false);
  expect(w.count()).toBe(1);
  w.select({ ...role(), model: "saaras:v4" });
  expect(w.store.sttBudgetHolds.reserve(w.owner, w.input)).toEqual(held);
  expect(w.calls()).toEqual({ role: 1, balance: 1 });
  expect(JSON.stringify(held)).not.toMatch(
    /canonical|digest|token|model|accountRef/,
  );
});
test("a configured role reader that disagrees with the price cannot fall back to an unbound hold", () => {
  const w = world();
  w.select({ ...role(), model: "saaras:v4" });
  expect(() => w.store.sttBudgetHolds.reserve(w.owner, w.input)).toThrow(
    "role",
  );
  expect(w.count("stt_budget_holds")).toBe(0);
  expect(w.count()).toBe(0);
  expect(w.calls().balance).toBe(0);
});

test("clients cannot provide a role or recorded binding and configured failures consume no units", () => {
  const w = world();
  for (const extra of [
    { role: role() },
    { roleBinding: "recorded" },
    { roleSnapshot: role() },
  ])
    expect(() =>
      w.store.sttBudgetHolds.reserve(w.owner, { ...w.input, ...extra }),
    ).toThrow("Invalid");
  expect(w.calls()).toEqual({ role: 0, balance: 0 });
  for (const bad of [
    undefined,
    () => {
      throw Error("synthetic-private-value");
    },
    () => Promise.resolve(role()),
    () => Promise.reject(Error("synthetic-private-value")),
  ]) {
    // Promise results are intentionally unsupported and their rejection is consumed by the boundary.
    w.select(bad);
    expect(() => w.store.sttBudgetHolds.reserve(w.owner, w.input)).toThrow(
      "role",
    );
    expect(w.count()).toBe(0);
    expect(w.count("stt_budget_holds")).toBe(0);
  }
});

test("an unknown snapshot trigger aborts the entire hold transaction instead of leaving an unbound hold", () => {
  const w = world();
  w.beforeBalance(() =>
    w.db.exec(
      "CREATE TRIGGER injected_role AFTER INSERT ON stt_hold_roles BEGIN INSERT INTO owners VALUES('synthetic-injected'); END",
    ),
  );
  expect(() => w.store.sttBudgetHolds.reserve(w.owner, w.input)).toThrow(
    "snapshot is unavailable",
  );
  expect(w.count()).toBe(0);
  expect(w.count("stt_budget_holds")).toBe(0);
  expect(
    w.db.query("SELECT id FROM owners WHERE id='synthetic-injected'").get(),
  ).toBeNull();
  w.db.exec("DROP TRIGGER injected_role");
  w.beforeBalance(() => {});
  expect(w.store.sttBudgetHolds.reserve(w.owner, w.input).roleBinding).toBe(
    "recorded",
  );
});

test("snapshot evidence is immutable and retained through cancellation, privacy removal and reopen", () => {
  const w = world(),
    held = w.store.sttBudgetHolds.reserve(w.owner, w.input);
  expect(() => w.db.exec("UPDATE stt_hold_roles SET digest='bad'")).toThrow(
    "immutable",
  );
  expect(() => w.db.exec("DELETE FROM stt_hold_roles")).toThrow("immutable");
  w.store.media.remove(w.owner, w.media.id);
  const cancelled = w.store.sttBudgetHolds.cancelUnissued(w.owner, held.id);
  expect(cancelled.roleBinding).toBe("recorded");
  expect(cancelled.executionAllowed).toBe(false);
  w.store.close();
  const reopened = new SelfHostedStore(w.path, { now: w.now });
  stores.push(reopened);
  expect(reopened.sttBudgetHolds.get(w.owner, held.id)).toEqual(cancelled);
  expect(w.count()).toBe(1);
});

test("old14 and metadata-only holds stay unbound; duplicates never backfill role authority", () => {
  const w = world(false),
    held = w.store.sttBudgetHolds.reserve(w.owner, w.input);
  expect(held.roleBinding).toBe("unbound");
  w.store.close();
  w.db.exec("DROP TABLE stt_hold_roles; UPDATE version SET value=14");
  const reopened = new SelfHostedStore(w.path, {
    now: w.now,
    sttRoleReader: () => {
      throw Error("No backfill expected");
    },
    sttBalanceReader: () => {
      throw Error("No observation expected");
    },
  });
  stores.push(reopened);
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(15);
  expect(reopened.sttBudgetHolds.reserve(w.owner, w.input)).toEqual(held);
  expect(w.count()).toBe(0);
  expect(
    reopened.sttBudgetHolds.cancelUnissued(w.owner, held.id).roleBinding,
  ).toBe("unbound");
});

test("a failed15 migration preserves old hold data/version and releases ownership", () => {
  const w = world(false),
    held = w.store.sttBudgetHolds.reserve(w.owner, w.input);
  w.store.close();
  w.db.exec(
    "DROP TABLE stt_hold_roles; UPDATE version SET value=14; CREATE VIEW stt_hold_roles AS SELECT 1 AS unsupported",
  );
  expect(() => {
    const candidate = new SelfHostedStore(w.path);
    stores.push(candidate);
  }).toThrow("snapshot is unavailable");
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(14);
  expect(w.count("stt_budget_holds")).toBe(1);
  w.db.exec("DROP VIEW stt_hold_roles");
  const reopened = new SelfHostedStore(w.path, { now: w.now });
  stores.push(reopened);
  expect(reopened.sttBudgetHolds.get(w.owner, held.id)).toEqual(held);
});

import { createSttRoleBinding } from "../src/self-hosted/stt-role-binding";

test("forged owner, canonical content, digest or timestamp fail closed and cannot release a hold", () => {
  for (const change of ["owner", "content", "digest", "time"]) {
    const w = world(false),
      held = w.store.sttBudgetHolds.reserve(w.owner, w.input),
      pin = createSttRoleBinding(w.profile, role());
    if (pin.kind !== "role_binding") throw Error("Expected synthetic metadata");
    w.db
      .query("INSERT INTO stt_hold_roles VALUES(?,?,?,?,?)")
      .run(
        held.id,
        change === "owner" ? "other-owner" : w.owner,
        change === "content" ? "{}" : pin.canonicalJson,
        change === "digest" ? "0".repeat(64) : pin.contentSha256,
        change === "time" ? held.created_at + 1 : held.created_at,
      );
    expect(() => w.store.sttBudgetHolds.get(w.owner, held.id)).toThrow(
      "snapshot is unavailable",
    );
    expect(() =>
      w.store.sttBudgetHolds.cancelUnissued(w.owner, held.id),
    ).toThrow("snapshot is unavailable");
    expect(
      w.db.query("SELECT state,cancelled_at FROM stt_budget_holds").get(),
    ).toEqual({ state: "held", cancelled_at: null });
    expect(w.count()).toBe(1);
  }
});

test("privacy changes during observation persist while no hold or snapshot is committed", () => {
  const w = world();
  w.beforeBalance(() => w.store.media.revokeProcessing(w.owner, w.media.id));
  expect(() => w.store.sttBudgetHolds.reserve(w.owner, w.input)).toThrow();
  expect(w.count()).toBe(0);
  expect(w.count("stt_budget_holds")).toBe(0);
  expect(w.store.media.metadata(w.owner, w.media.id).consentToProcess).toBe(
    false,
  );
});
