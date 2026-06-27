import { Injectable } from "@nestjs/common";
import { AssignableMember } from "./clickup.types";

/**
 * Bridges a pipeline roster name (`assigneeName`, a transcript participant) to a
 * ClickUp member id — but ONLY from the workspace's allowlist of assignable
 * members. A name that matches nobody in the allowlist resolves to null
 * ("Unassigned"); it NEVER matches a member outside the allowlist. The human
 * confirms/overrides the suggestion in the UI before any push.
 */
@Injectable()
export class AssigneeResolverService {
  /**
   * Suggest a `clickupUserId` for a roster name:
   *   1. case-insensitive exact full-name match,
   *   2. else first-name match (first token equal),
   *   3. else a containment best-match (one name is a token-prefix of the other),
   * always restricted to `members`. Returns null when nothing matches.
   */
  resolve(assigneeName: string | null | undefined, members: AssignableMember[]): string | null {
    if (!assigneeName) return null;
    const target = norm(assigneeName);
    if (!target) return null;

    // 1. Exact full-name (case-insensitive).
    const exact = members.find((m) => norm(m.name) === target);
    if (exact) return exact.clickupUserId;

    const targetFirst = firstToken(target);

    // 2. First-name match.
    const byFirst = members.find((m) => firstToken(norm(m.name)) === targetFirst);
    if (byFirst) return byFirst.clickupUserId;

    // 3. Containment best-match (e.g. "Sarah" ⊂ "Sarah Khan", or vice-versa).
    const contained = members.find((m) => {
      const name = norm(m.name);
      return (
        name.startsWith(`${target} `) ||
        target.startsWith(`${name} `) ||
        name === target
      );
    });
    return contained ? contained.clickupUserId : null;
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function firstToken(s: string): string {
  return s.split(" ")[0] ?? "";
}
