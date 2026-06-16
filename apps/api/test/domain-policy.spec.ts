import { describe, expect, it } from "vitest";
import {
  type DomainPolicy,
  emailDomain,
  isSignInAllowed,
  parseDomainPolicy,
} from "../src/auth/domain-policy";

describe("domain policy", () => {
  describe("parseDomainPolicy", () => {
    it("defaults to datagenie.ai + scope 'google'", () => {
      expect(parseDomainPolicy({})).toEqual({ allowedDomains: ["datagenie.ai"], scope: "google" });
    });

    it("parses a comma list (trimmed, lowercased) and the 'all' scope", () => {
      const p = parseDomainPolicy({
        VARYS_AUTH_ALLOWED_DOMAINS: " Datagenie.ai , Example.com ",
        VARYS_AUTH_DOMAIN_SCOPE: "all",
      });
      expect(p).toEqual({ allowedDomains: ["datagenie.ai", "example.com"], scope: "all" });
    });

    it("treats an empty allow-list as unrestricted", () => {
      expect(parseDomainPolicy({ VARYS_AUTH_ALLOWED_DOMAINS: "" }).allowedDomains).toEqual([]);
    });

    it("falls back to scope 'google' for any non-'all' value", () => {
      expect(parseDomainPolicy({ VARYS_AUTH_DOMAIN_SCOPE: "sso" }).scope).toBe("google");
    });
  });

  describe("emailDomain", () => {
    it("extracts the lowercased domain", () => {
      expect(emailDomain("Alice@Datagenie.AI")).toBe("datagenie.ai");
    });
    it("returns '' for a malformed address", () => {
      expect(emailDomain("not-an-email")).toBe("");
    });
  });

  describe("isSignInAllowed", () => {
    const restricted: DomainPolicy = { allowedDomains: ["datagenie.ai"], scope: "google" };
    const restrictedAll: DomainPolicy = { allowedDomains: ["datagenie.ai"], scope: "all" };
    const unrestricted: DomainPolicy = { allowedDomains: [], scope: "google" };

    it("allows everything when unrestricted", () => {
      expect(isSignInAllowed("anyone@whatever.com", "google", unrestricted)).toBe(true);
      expect(isSignInAllowed("anyone@whatever.com", "credential", unrestricted)).toBe(true);
    });

    it("scope 'google': restricts Google to the allow-list", () => {
      expect(isSignInAllowed("ada@datagenie.ai", "google", restricted)).toBe(true);
      expect(isSignInAllowed("ada@gmail.com", "google", restricted)).toBe(false);
    });

    it("scope 'google': leaves email/password unrestricted", () => {
      expect(isSignInAllowed("ada@gmail.com", "credential", restricted)).toBe(true);
    });

    it("scope 'all': restricts every method to the allow-list", () => {
      expect(isSignInAllowed("ada@datagenie.ai", "credential", restrictedAll)).toBe(true);
      expect(isSignInAllowed("ada@gmail.com", "credential", restrictedAll)).toBe(false);
      expect(isSignInAllowed("ada@gmail.com", "google", restrictedAll)).toBe(false);
    });

    it("matches the domain exactly (no subdomain leakage)", () => {
      expect(isSignInAllowed("ada@evil-datagenie.ai", "google", restricted)).toBe(false);
      expect(isSignInAllowed("ada@sub.datagenie.ai", "google", restricted)).toBe(false);
    });
  });
});
