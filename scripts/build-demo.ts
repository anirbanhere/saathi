import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."),
  out = join(root, "artifacts/public-build");
await mkdir(out, { recursive: true });
const run = (args: string[]) => {
  const result = Bun.spawnSync(args, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode)
    throw new Error(
      `Build command failed: ${result.stderr.toString().slice(0, 1000)}`,
    );
  return result.stdout.toString().trim();
};
run([
  process.execPath,
  "build",
  "--target=bun",
  "--env=disable",
  "--minify",
  `--metafile=${join(out, "metafile.json")}`,
  `--outfile=${join(out, "app.js")}`,
  "openbot/server/src/self-hosted/index.ts",
]);
const files = [
  "LICENSE",
  ...run(["git", "ls-files", "openbot/examples/saathi"]).split(/\r?\n/),
  "saathi-web/index.html",
  "saathi-web/app.js",
  "saathi-web/appointments.js",
  "saathi-web/plans.js",
  "saathi-web/media.js",
  "saathi-web/upload.js",
  "saathi-web/style.css",
];
for (const name of ["hono", "zod", "yaml"]) {
  await mkdir(join(out, "licenses"), { recursive: true });
  await copyFile(
    join(root, "openbot/server/node_modules", name, "LICENSE"),
    join(out, "licenses", `${name}-LICENSE`),
  );
}
for (const name of ["drizzle-orm-LICENSE", "bun-LICENSE.md"])
  await copyFile(
    join(root, "deploy/public/licenses", name),
    join(out, "licenses", name),
  );
for (const file of files) {
  if (
    !file ||
    file.includes("..") ||
    !/^(LICENSE|openbot\/examples\/saathi\/.*\.(yaml|md)|saathi-web\/(index\.html|app\.js|appointments\.js|plans\.js|media\.js|upload\.js|style\.css))$/.test(
      file,
    )
  )
    throw new Error("Unexpected build input.");
  const target = join(out, file.startsWith("openbot/") ? file.slice(8) : file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, file), target);
}
let runtimeIntegrity: string | null = null;
if (process.argv.includes("--runtime")) {
  const metadata = (await (
    await fetch("https://registry.npmjs.org/@oven%2Fbun-linux-x64/1.4.3", {
      signal: AbortSignal.timeout(15000),
    })
  ).json()) as { dist: { tarball: string; integrity: string } };
  if (
    !metadata.dist.tarball.startsWith(
      "https://registry.npmjs.org/@oven/bun-linux-x64/",
    ) ||
    !metadata.dist.integrity.startsWith("sha512-")
  )
    throw new Error("Unexpected runtime distribution.");
  const archive = Bun.file(join(out, "linux-runtime.tgz"));
  const bytes = (await archive.exists())
    ? await archive.arrayBuffer()
    : await (
        await fetch(metadata.dist.tarball, {
          signal: AbortSignal.timeout(60000),
        })
      ).arrayBuffer();
  if (
    `sha512-${createHash("sha512").update(Buffer.from(bytes)).digest("base64")}` !==
    metadata.dist.integrity
  )
    throw new Error("Runtime integrity mismatch.");
  await Bun.write(archive, bytes);
  runtimeIntegrity = metadata.dist.integrity;
}
const metafile = (await Bun.file(join(out, "metafile.json")).json()) as {
  inputs: Record<string, unknown>;
};
const packages = [
  ...new Set(
    Object.keys(metafile.inputs)
      .filter((p) => p.includes("node_modules"))
      .map((p) => p.match(/node_modules[\\/]\.bun[\\/]([^\\/]+)/)?.[1])
      .filter(Boolean),
  ),
];
const manifest = {
  source: run(["git", "rev-parse", "HEAD"]),
  dirty: !!run(["git", "status", "--porcelain"]),
  bun: "1.4.3",
  bundleSha256: createHash("sha256")
    .update(await Bun.file(join(out, "app.js")).bytes())
    .digest("hex"),
  runtimeIntegrity,
  packages,
  files: [
    "app.js",
    "manifest.json",
    ...files.map((file) =>
      file.startsWith("openbot/") ? file.slice(8) : file,
    ),
    ...[
      "hono-LICENSE",
      "zod-LICENSE",
      "yaml-LICENSE",
      "drizzle-orm-LICENSE",
      "bun-LICENSE.md",
    ].map((name) => `licenses/${name}`),
    ...(runtimeIntegrity ? ["linux-runtime.tgz"] : []),
  ],
};
if (process.argv.includes("--audit")) {
  const audit = Bun.spawnSync([process.execPath, "audit", "--json"], {
    cwd: join(root, "openbot"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const report = JSON.parse(audit.stdout.toString()) as Record<
    string,
    { vulnerable_versions: string; url: string }[]
  >;
  const hits: string[] = [];
  for (const spec of packages) {
    if (!spec) continue;
    const at = spec.lastIndexOf("@"),
      name = spec.slice(0, at),
      version = spec.slice(at + 1).split("+")[0];
    if (!version) throw new Error("Unknown bundle version");
    for (const advisory of report[name] ?? [])
      if (Bun.semver.satisfies(version, advisory.vulnerable_versions))
        hits.push(`${name}: ${advisory.url}`);
  }
  if (hits.length)
    throw new Error(`Bundled dependency advisories: ${hits.join(", ")}`);
  console.log(
    `Bundled dependency advisory matches: 0. Full repository advisory packages: ${Object.keys(report).length}; non-bundled dependencies are not shipped.`,
  );
}
await Bun.write(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
