import type { AgentProfileStore } from "./profile-store";
import type { AgentActor } from "./profile-types";

/**
 * Who may watch, drive or take over a Bot's computer.
 *
 * Seeing a Bot is not enough. A Team Bot reaches teammates through its owner's publication, but its
 * computer is one per Bot and carries the owner's browser: the sites the owner signed into, through
 * the password manager or by hand. A teammate chats with the Team Bot and it still acts for them
 * through its own governed tools; only the owner (or an administrator) sees the screen or takes
 * control. Public Bots are shared by everyone who can sign in, so their computer is too.
 */
export function canUseComputer(
  profile: { visibility: string; ownerUserId: string | null } | null,
  actor: Pick<AgentActor, "id" | "role">,
  ownerOnly = false,
): boolean {
  if (!profile) return false;
  if (ownerOnly) return profile.ownerUserId === actor.id;
  return (
    actor.role === "admin" ||
    profile.visibility === "public" ||
    profile.ownerUserId === actor.id
  );
}

/** The access check the computer routes and the live screen use, read from the profile store. */
export function computerAccessCheck(
  store: Pick<AgentProfileStore, "get">,
  ownerOnly = false,
) {
  return async (actor: AgentActor, botId: string) =>
    canUseComputer(
      await store.get(actor, botId).catch(() => null),
      actor,
      ownerOnly,
    );
}
