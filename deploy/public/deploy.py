"""Explicit operator deployment, never run by PR CI. No secrets in arguments/logs/source."""
import ipaddress
import json
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from release_inputs import pack_release, validate_build

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "sathi-home-agent"
REGION = "us-central1"
ZONE = "us-central1-a"
BUCKET = "saathi-demo-releases-59012364414"
VM = "saathi-demo"
IDENTITY = f"saathi-demo-vm@{PROJECT}.iam.gserviceaccount.com"
GCLOUD = shutil.which("gcloud.cmd") or shutil.which("gcloud")
if not GCLOUD:
    raise SystemExit("gcloud is required.")


def cloud(*args, payload=None, missing=False):
    result = subprocess.run([GCLOUD, *args, f"--project={PROJECT}", "--quiet", "--format=json"], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        error = result.stderr.decode(errors="replace")
        if missing and any(term in error for term in ("NOT_FOUND", "not found", "does not exist", "NotFound", "404")):
            return None
        # Payload is supplied only for secret version creation; never expose its diagnostics.
        raise RuntimeError(f"GCP step failed: {' '.join(args[:3])}. " + ("Secret upload diagnostics withheld." if payload else error[-1200:]))
    text = result.stdout.decode(errors="replace").strip()
    return json.loads(text) if text else {}


def ensure(probe, create):
    if cloud(*probe, missing=True) is None:
        cloud(*create)


def update_existing(archive, manifest, digest, object_name):
    """Explicit update: retain identities/secrets/network and stop before a consistent disk snapshot."""
    instance = cloud("compute", "instances", "describe", VM, f"--zone={ZONE}")
    if instance.get("status") != "RUNNING" or [row.get("email") for row in instance.get("serviceAccounts", [])] != [IDENTITY]:
        raise RuntimeError("Expected running VM/resource-scoped identity not found; update refused.")
    disk = next((row for row in instance.get("disks", []) if row.get("deviceName") == "saathi-data"), None)
    if not disk or disk.get("autoDelete") is not False or not disk.get("source", "").endswith("/disks/saathi-demo-data"):
        raise RuntimeError("Expected retained data disk not found; update refused.")
    address = cloud("compute", "addresses", "describe", "saathi-demo-ip", f"--region={REGION}")["address"]
    ipaddress.IPv4Address(address)
    host = f"{address}.sslip.io"
    cloud("storage", "cp", str(archive), f"gs://{BUCKET}/{object_name}", "--if-generation-match=0")
    startup = (ROOT / "deploy/public/startup.sh").read_text(encoding="utf-8")
    for key, value in {"PROJECT": PROJECT, "HOST": host, "BUCKET": BUCKET, "OBJECT": object_name, "SHA256": digest}.items():
        startup = startup.replace(f"__{key}__", value)
    rendered = ROOT / "artifacts/saathi-vm-startup.sh"
    rendered.write_text(startup, encoding="utf-8", newline="\n")
    previous = {"metadata": instance.get("metadata"), "release": json.loads((ROOT / "artifacts/public-deploy-state.json").read_text())}
    (ROOT / "artifacts/public-deploy-previous.json").write_text(json.dumps(previous, indent=2), encoding="utf-8")
    snapshot = "saathi-demo-data-pre-web-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    print("Stopping existing demo for a consistent data-disk backup before migration.", flush=True)
    cloud("compute", "instances", "stop", VM, f"--zone={ZONE}")
    try:
        cloud("compute", "snapshots", "create", snapshot, "--source-disk=saathi-demo-data", f"--source-disk-zone={ZONE}", f"--storage-location={REGION}")
        backup = cloud("compute", "snapshots", "describe", snapshot)
        if backup.get("status") != "READY":
            raise RuntimeError("Pre-migration snapshot is not ready; update refused.")
        cloud("compute", "instances", "add-metadata", VM, f"--zone={ZONE}", f"--metadata-from-file=startup-script={rendered}")
    finally:
        # If snapshot fails, unchanged metadata boots the previous release. Never erase/restore data automatically.
        cloud("compute", "instances", "start", VM, f"--zone={ZONE}")
    state = {"project": PROJECT, "region": REGION, "zone": ZONE, "vm": VM, "url": f"https://{host}/", "source": manifest["source"], "archive_sha256": digest, "object": object_name, "pre_migration_snapshot": snapshot}
    (ROOT / "artifacts/public-deploy-state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    print(json.dumps(state, indent=2))


def main():
    build = ROOT / "artifacts/public-build"
    # Pure input validation precedes any private-profile read or cloud call.
    validate_build(build)
    private = {}
    for line in (ROOT / "openbot/.env.self-hosted").read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            private[key.strip()] = value.strip().strip('"').strip("'")
    keys = {"saathi-demo-meta-key": private.get("META_API_KEY") or private.get("MODEL_API_KEY"), "saathi-demo-openrouter-key": private.get("OPENROUTER_API_KEY") or private.get("OPENAI_API_KEY")}
    if not all(keys.values()):
        raise RuntimeError("Both provider keys must exist in the private profile.")
    archive = ROOT / "artifacts/saathi-demo-release.tgz"
    manifest, digest = pack_release(build, archive, secret_values=keys.values())
    object_name = f"releases/{manifest['source']}-{digest}.tgz"
    if "--update" in sys.argv[1:]:
        update_existing(archive, manifest, digest, object_name)
        return
    ensure(["iam", "service-accounts", "describe", IDENTITY], ["iam", "service-accounts", "create", "saathi-demo-vm", "--display-name=Saathi isolated demo VM"])
    for name, value in keys.items():
        ensure(["secrets", "describe", name], ["secrets", "create", name, "--replication-policy=automatic"])
        cloud("secrets", "versions", "add", name, "--data-file=-", payload=value.encode())
        cloud("secrets", "add-iam-policy-binding", name, f"--member=serviceAccount:{IDENTITY}", "--role=roles/secretmanager.secretAccessor")
    ensure(["storage", "buckets", "describe", f"gs://{BUCKET}"], ["storage", "buckets", "create", f"gs://{BUCKET}", f"--location={REGION}", "--uniform-bucket-level-access", "--public-access-prevention"])
    cloud("storage", "buckets", "add-iam-policy-binding", f"gs://{BUCKET}", f"--member=serviceAccount:{IDENTITY}", "--role=roles/storage.objectViewer")
    cloud("storage", "cp", str(archive), f"gs://{BUCKET}/{object_name}", "--if-generation-match=0")
    ensure(["compute", "networks", "describe", "saathi-demo-net"], ["compute", "networks", "create", "saathi-demo-net", "--subnet-mode=custom"])
    ensure(["compute", "networks", "subnets", "describe", "saathi-demo-central", f"--region={REGION}"], ["compute", "networks", "subnets", "create", "saathi-demo-central", "--network=saathi-demo-net", "--range=10.81.0.0/28", f"--region={REGION}"])
    ensure(["compute", "firewall-rules", "describe", "saathi-demo-https"], ["compute", "firewall-rules", "create", "saathi-demo-https", "--network=saathi-demo-net", "--allow=tcp:80,tcp:443", "--source-ranges=0.0.0.0/0", "--target-tags=saathi-demo-web"])
    ensure(["compute", "firewall-rules", "describe", "saathi-demo-iap"], ["compute", "firewall-rules", "create", "saathi-demo-iap", "--network=saathi-demo-net", "--allow=tcp:22", "--source-ranges=35.235.240.0/20", "--target-tags=saathi-demo-web"])
    ensure(["compute", "addresses", "describe", "saathi-demo-ip", f"--region={REGION}"], ["compute", "addresses", "create", "saathi-demo-ip", f"--region={REGION}", "--network-tier=STANDARD"])
    address = cloud("compute", "addresses", "describe", "saathi-demo-ip", f"--region={REGION}")["address"]
    ipaddress.IPv4Address(address)
    host = f"{address}.sslip.io"
    startup = (ROOT / "deploy/public/startup.sh").read_text(encoding="utf-8")
    for key, value in {"PROJECT": PROJECT, "HOST": host, "BUCKET": BUCKET, "OBJECT": object_name, "SHA256": digest}.items():
        startup = startup.replace(f"__{key}__", value)
    rendered = ROOT / "artifacts/saathi-vm-startup.sh"
    rendered.write_text(startup, encoding="utf-8", newline="\n")
    state = {"project": PROJECT, "region": REGION, "zone": ZONE, "vm": VM, "url": f"https://{host}/", "source": manifest["source"], "archive_sha256": digest, "object": object_name}
    (ROOT / "artifacts/public-deploy-state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    ensure(["compute", "instances", "describe", VM, f"--zone={ZONE}"], ["compute", "instances", "create", VM, f"--zone={ZONE}", "--machine-type=e2-micro", "--subnet=saathi-demo-central", "--network-tier=STANDARD", f"--address={address}", "--tags=saathi-demo-web", f"--service-account={IDENTITY}", "--scopes=cloud-platform", "--image-family=debian-12", "--image-project=debian-cloud", "--boot-disk-size=10GB", "--boot-disk-type=pd-standard", "--create-disk=name=saathi-demo-data,device-name=saathi-data,size=10,type=pd-standard,auto-delete=no", "--shielded-secure-boot", "--shielded-vtpm", "--shielded-integrity-monitoring", "--metadata=block-project-ssh-keys=TRUE,enable-oslogin=TRUE", f"--metadata-from-file=startup-script={rendered}"])
    print(json.dumps(state, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
