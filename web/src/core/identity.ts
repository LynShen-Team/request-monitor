import type { Viewer } from "./model";

/**
 * Who opened the screen. The server decides it from the gateway session token that arrives with
 * the request; the page never chooses its own role.
 *
 * - `admin`: the gateway reports role `admin` or `super_admin`.
 * - `user`: a valid session with any other role.
 * - `guest`: no token, an expired token, or a gateway that could not be asked (fail closed).
 */
export type Role = "admin" | "user" | "guest";

export interface IdentitySource {
  identify(): Promise<Role>;
}

/** A signed-in user and a guest see the same data; only an admin sees restricted Channels. */
export function viewerOf(role: Role): Viewer {
  return role === "admin" ? "admin" : "user";
}

export const ROLE_LABEL: Record<Role, string> = { admin: "管理员", user: "用户", guest: "访客" };
