import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { client } from "@/lib/client";

type Call = {
  id: string;
  direction: string;
  status: string;
  number: string;
  purpose: string;
  disclosure: string;
  language: string;
  maxSeconds: number;
  previewHash: string;
  summary: string;
  createdAt: number;
  aiSpeaking: boolean;
};
type State = {
  mode: string;
  liveCalling: false;
  numberAssigned: false;
  required: string[];
  calls: Call[];
};
export function SaathiCalls() {
  const [number, setNumber] = useState("");
  const [purpose, setPurpose] = useState("");
  const [disclosure, setDisclosure] = useState("First name only");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = useQuery({
    queryKey: ["saathi", "calls"],
    queryFn: async (): Promise<State> =>
      (await client("/api/saathi/calls")).json(),
    refetchInterval: 5000,
  });
  async function perform(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await client(`/api/saathi/calls${path}`, { method: "POST", body });
      await data.refetch();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Call controls are unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  function request(event: FormEvent) {
    event.preventDefault();
    void perform("", {
      number,
      purpose,
      disclosure,
      language: "en-IN",
      maxSeconds: 120,
    });
  }
  return (
    <PageSection title="Phone calls">
      <p className="mt-2 text-sm text-muted-foreground">
        India calling setup · No phone number is assigned yet. Real incoming and
        outgoing calls are disabled.
      </p>
      {data.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Could not load private call controls.
        </p>
      ) : null}
      {data.data ? (
        <ul className="mt-3 list-disc pl-5 text-sm text-muted-foreground">
          {data.data.required.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p role="status">Loading calling setup…</p>
      )}
      {data.data?.mode === "simulation" ? (
        <div className="mt-5 space-y-5">
          <p className="rounded-md border p-3 text-sm" role="note">
            <strong>Simulation only.</strong> These controls test approvals,
            incoming calls and takeover. No number is dialed, no audio is sent,
            no recording is made and no provider charge is incurred.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <form onSubmit={request} className="space-y-3">
            <div>
              <Label htmlFor="call-number">
                Recipient / simulated caller number
              </Label>
              <Input
                id="call-number"
                required
                type="tel"
                placeholder="+919876543210"
                pattern="\+91[1-9][0-9]{9}"
                value={number}
                onChange={(event) => setNumber(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="call-purpose">Call purpose</Label>
              <Input
                id="call-purpose"
                required
                minLength={3}
                maxLength={500}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Ask the restaurant about opening hours"
              />
            </div>
            <div>
              <Label htmlFor="call-disclosure">
                Information the assistant may share
              </Label>
              <Input
                id="call-disclosure"
                required
                maxLength={500}
                value={disclosure}
                onChange={(event) => setDisclosure(event.target.value)}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Preview language: English (India). Maximum test session: 2
              minutes. AI disclosure is mandatory; incoming caller ID is
              unverified.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} type="submit">
                Preview outgoing call
              </Button>
              <Button
                disabled={busy || !/^\+91[1-9]\d{9}$/.test(number)}
                type="button"
                variant="outline"
                onClick={() => void perform("/simulate-incoming", { number })}
              >
                Simulate incoming call
              </Button>
            </div>
          </form>
          <div className="space-y-3" aria-live="polite">
            {data.data.calls.map((call) => (
              <article
                key={call.id}
                className="rounded-md border p-4 space-y-2"
              >
                <p className="font-medium">
                  {call.direction === "outgoing" ? "Outgoing" : "Incoming"}{" "}
                  simulation · {call.number}
                </p>
                <p className="text-sm">
                  Status: {call.status.replaceAll("_", " ")} · {call.maxSeconds}
                  s limit · {call.language}
                </p>
                <p className="text-sm">Purpose: {call.purpose}</p>
                <p className="text-sm">May share: {call.disclosure}</p>
                <p className="text-sm text-muted-foreground">{call.summary}</p>
                <div className="flex flex-wrap gap-2">
                  {call.status === "awaiting_approval" ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(`/${call.id}/approve`, {
                          previewHash: call.previewHash,
                        })
                      }
                    >
                      Approve this simulated call
                    </Button>
                  ) : null}
                  {call.status === "ringing" ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(`/${call.id}/control`, {
                          action: "answer",
                        })
                      }
                    >
                      Simulate answer
                    </Button>
                  ) : null}
                  {call.status === "connected" ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(`/${call.id}/control`, {
                          action: "takeover",
                        })
                      }
                    >
                      Simulate human takeover
                    </Button>
                  ) : null}
                  {!["ended", "canceled"].includes(call.status) ? (
                    <Button
                      disabled={busy}
                      variant="outline"
                      onClick={() =>
                        void perform(`/${call.id}/control`, { action: "end" })
                      }
                    >
                      {call.status === "awaiting_approval"
                        ? "Cancel request"
                        : "End simulation"}
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm">
          The operator can enable the private simulator while the carrier
          account is being prepared.
        </p>
      )}
    </PageSection>
  );
}
