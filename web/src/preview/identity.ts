import type { IdentitySource, Role } from "../core/identity";

/**
 * Preview stand-in for the gateway session check. The preview has no gateway and sends no
 * request, so nothing can be identified: `?as=admin|user|guest` says which visitor to simulate,
 * and the default is the reviewer's own role. The production source asks the gateway instead
 * (docs/spec-draft.md OS-B6) and answers `guest` whenever it cannot.
 */
export class PreviewIdentity implements IdentitySource {
  private readonly params: URLSearchParams;

  constructor(params: URLSearchParams) {
    this.params = params;
  }

  async identify(): Promise<Role> {
    const as = this.params.get("as");
    return as === "user" || as === "guest" ? as : "admin";
  }
}
