import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageSection } from "@/components/layout/page-shell";
import { client } from "@/lib/client";
import { SaathiCalls } from "./saathi-calls";
import { SaathiSwiggy } from "./saathi-swiggy";

type Provider = "openai" | "anthropic" | "meta";
type Status = {
  models: { provider: Provider; model: string; selected: boolean }[];
  speechConfigured: boolean;
  connection: {
    status: string;
    lastError: string | null;
    channelId: string;
    pairingExpiresAt: string | null;
  } | null;
};
const saathiStatusKey = ["saathi", "status"] as const;

export function SaathiSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: saathiStatusKey,
    queryFn: async (): Promise<Status> =>
      (
        await client("/api/saathi/status", {
          fallback: "Saathi is not enabled on this server.",
        })
      ).json(),
    refetchInterval: (query) =>
      query.state.data?.connection?.status === "pairing" ? 2000 : false,
  });
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [pairing, setPairing] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await queryClient.invalidateQueries({ queryKey: saathiStatusKey });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "This change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey.trim();
    setApiKey("");
    // Secret submissions bypass React Query mutation state and its cache.
    await perform(async () => {
      await client(key ? "/api/saathi/model-key" : "/api/saathi/model", {
        method: key ? "POST" : "PUT",
        body: {
          provider,
          model: model.trim(),
          ...(key ? { apiKey: key } : {}),
        },
      });
      setNotice(
        "Model saved for your next run. Current work keeps its existing model.",
      );
    });
  }
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = token.trim();
    setToken("");
    setPairing("");
    await perform(async () => {
      const response = await client("/api/saathi/whatsapp", {
        method: "POST",
        body: { token: secret },
      });
      const value = (await response.json()) as { pairingCode: string };
      setPairing(value.pairingCode);
      setNotice(
        "Send the pairing code in your WhatsApp agent chat within 10 minutes.",
      );
    });
  }
  if (status.isPending)
    return (
      <p role="status" className="mt-8 text-muted-foreground">
        Loading your Saathi settings...
      </p>
    );
  if (status.isError)
    return (
      <p role="alert" className="mt-8 text-destructive">
        {status.error.message}
      </p>
    );
  const data = status.data;
  const hasKey = data.models.some((value) => value.provider === provider);
  return (
    <div className="space-y-10 pb-10">
      <SaathiCalls />
      <SaathiSwiggy />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        WhatsApp is optional for the web companion. After saving your model,
        open your private assistant from the{" "}
        <a href="/" className="underline underline-offset-4">
          Chat tab
        </a>{" "}
        or Bots. The shared welcome Bot only helps with setup.
      </p>
      <PageSection title="Your model">
        <p className="mt-2 text-sm text-muted-foreground">
          Choose the model Saathi uses for your tasks. Keys are encrypted and
          never returned to this screen. Your provider bills your model usage.
        </p>
        {data.models.length ? (
          <ul className="mt-4 divide-y rounded-lg border">
            {data.models.map((value) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 p-4"
                key={value.provider}
              >
                <div>
                  <p className="font-medium">{value.model}</p>
                  <p className="text-sm text-muted-foreground">
                    {value.provider} ·{" "}
                    {value.selected ? "Selected for new runs" : "Key saved"}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!value.selected ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          await client("/api/saathi/model", {
                            method: "PUT",
                            body: {
                              provider: value.provider,
                              model: value.model,
                            },
                          });
                          setNotice("Model changed for new runs.");
                        })
                      }
                    >
                      Use model
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await client(
                          `/api/saathi/model-key/${value.provider}`,
                          { method: "DELETE" },
                        );
                        setNotice("Key revoked. New calls cannot use it.");
                      })
                    }
                  >
                    Revoke key
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm">Add your first API key to start.</p>
        )}
        <form onSubmit={saveModel} className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="saathi-provider">Provider</Label>
              <select
                id="saathi-provider"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as Provider);
                  setApiKey("");
                }}
                disabled={busy}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="meta">Meta (Muse)</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="saathi-model">Model ID</Label>
              <Input
                id="saathi-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={
                  provider === "meta"
                    ? "muse-spark-1.3"
                    : "Your provider's model ID"
                }
                required
                maxLength={120}
                disabled={busy}
                autoComplete="off"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="saathi-key">
              {hasKey ? "New API key if replacing the saved key" : "API key"}
            </Label>
            <Input
              id="saathi-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required={!hasKey}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
            />
          </div>
          <Button type="submit" disabled={busy || !model.trim()}>
            {busy
              ? "Saving..."
              : apiKey.trim() || !hasKey
                ? "Verify access and save key"
                : "Use saved key"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Verification checks access at the provider's model endpoint. Task
            tools depend on the model and connections available to you.
            {provider === "meta"
              ? " Use your Meta Model API key and a text model ID enabled for your team. Requests go directly to api.meta.ai."
              : ""}
          </p>
        </form>
      </PageSection>
      <PageSection title="WhatsApp connection">
        <p className="mt-2 text-sm text-muted-foreground">
          In WhatsApp, open Settings → Agents, create an agent, and copy its API
          key from Chat info. This feature is available only to eligible
          accounts. This key is separate from your model API key.
        </p>
        <p className="mt-4 text-sm">
          <span className="font-medium">Connection: </span>
          {data.connection?.status ?? "Not connected"}
        </p>
        {data.connection?.lastError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {data.connection.lastError}
          </p>
        ) : null}
        {data.connection?.status === "connected" ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <a
              className="text-sm underline underline-offset-4"
              href={`/channel/${encodeURIComponent(data.connection.channelId)}`}
            >
              Open your private conversation
            </a>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  await client("/api/saathi/whatsapp", { method: "DELETE" });
                  setPairing("");
                  setNotice(
                    "WhatsApp disconnected. Future polling and sends have stopped.",
                  );
                })
              }
            >
              Disconnect WhatsApp
            </Button>
          </div>
        ) : (
          <form onSubmit={connect} className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="saathi-whatsapp-token">
                WhatsApp agent API key
              </Label>
              <Input
                id="saathi-whatsapp-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
                disabled={busy || !data.models.some((value) => value.selected)}
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
              />
            </div>
            <Button
              disabled={
                busy ||
                !token.trim() ||
                !data.models.some((value) => value.selected)
              }
              type="submit"
            >
              {busy ? "Connecting..." : "Connect WhatsApp agent"}
            </Button>
          </form>
        )}
        {pairing && data.connection?.status !== "connected" ? (
          <div className="mt-5 space-y-2">
            <p className="text-sm">
              Send this exact message in your agent chat:
            </p>
            <code className="block break-all rounded-md border p-3 text-sm select-all">
              {pairing}
            </code>
          </div>
        ) : null}
        <p className="mt-4 text-xs text-muted-foreground">
          Agent chats pass through Meta and Saathi and are not end-to-end
          encrypted. Your agent sees only its own chat and cannot access family
          groups or other conversations.
        </p>
      </PageSection>
      <PageSection title="Voice and task controls">
        <p className="mt-2 text-sm">
          {data.speechConfigured
            ? "Voice transcription is configured. Speech quality depends on the provider and language."
            : "Voice transcription needs a speech service configured by the operator. Text requests work with your selected model."}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Send /help in WhatsApp for commands, /models to see saved models,
          /model followed by a provider and model ID to switch, or /stop to
          cancel WhatsApp turns. Existing approval requests remain in the
          companion. Consequential actions use the approval gateway; logins and
          payments use the companion handover.
        </p>
      </PageSection>
    </div>
  );
}
