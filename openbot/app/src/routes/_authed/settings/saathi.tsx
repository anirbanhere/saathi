import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SaathiSettings } from "@/components/settings/saathi-settings";

export const Route = createFileRoute("/_authed/settings/saathi")({
  component: SaathiSettingsPage,
});
function SaathiSettingsPage() {
  return (
    <PageShell
      title="Saathi"
      description="Choose your model and connect your personal WhatsApp agent."
    >
      <div className="mt-6">
        <SaathiSettings />
      </div>
    </PageShell>
  );
}
