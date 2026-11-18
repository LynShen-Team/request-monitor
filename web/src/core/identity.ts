import type { ScreenConfig } from "./config";
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

/**
 * A source rejects with this when the visitor must sign in to the gateway before the screen
 * opens (the deployment lets no guest in). The page shows a sign-in message instead of data.
 */
export class LoginRequired extends Error {
  /** Where to sign in; null when the source names no place. */
  readonly loginUrl: string | null;
  /** The brand to show around the message. */
  readonly config: ScreenConfig;
  /** Asks the source again; true once it says that the visitor may open the screen. */
  readonly recheck: () => Promise<boolean>;

  constructor(loginUrl: string | null, config: ScreenConfig, recheck: () => Promise<boolean>) {
    super("login required");
    this.name = "LoginRequired";
    this.loginUrl = loginUrl;
    this.config = config;
    this.recheck = recheck;
  }
}
