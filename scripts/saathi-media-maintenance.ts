import { LocalError } from "../openbot/server/src/self-hosted/errors";
import {
  maintainMedia,
  parseMediaMaintenanceArgs,
} from "../openbot/server/src/self-hosted/media-maintenance";

try {
  const { path, apply } = parseMediaMaintenanceArgs(process.argv.slice(2));
  console.log(JSON.stringify(maintainMedia(path, { apply })));
} catch (error) {
  console.error(
    error instanceof LocalError
      ? error.message
      : "Media maintenance could not finish. Check current state before retrying.",
  );
  process.exitCode = 1;
}
