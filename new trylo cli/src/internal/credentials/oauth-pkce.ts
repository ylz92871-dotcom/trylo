import crypto from "node:crypto";

/**
 * OAuth 2.0 PKCE (RFC 7636) primitives.
 *
 * Implemented using Node's built-in `node:crypto` without external dependencies.
 * Only the secure "S256" transformation is supported; plain text challenge is
 * forbidden to ensure security.
 */

export type PkceChallenge = {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
};

/**
 * Generate a cryptographically random code verifier (43-128 chars base64url)
 * and its SHA-256 code challenge.
 */
export function generatePkce(byteLength = 32): PkceChallenge {
  // 32 bytes base64url encoded produces 43 characters, matching RFC 7636 recommendations.
  const verifier = crypto.randomBytes(byteLength).toString("base64url");
  const challenge = computeChallenge(verifier);

  return {
    verifier,
    challenge,
    method: "S256",
  };
}

/**
 * Computes the S256 challenge for a given verifier: BASE64URL(SHA256(verifier)).
 */
export function computeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Verifies that a supplied code verifier matches the stored S256 code challenge.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") {
    return false;
  }

  if (verifier.length < 43 || verifier.length > 128) {
    return false;
  }

  const expectedChallenge = computeChallenge(verifier);
  // Constant-time comparison to prevent timing attacks.
  const expectedBuf = Buffer.from(expectedChallenge, "utf8");
  const actualBuf = Buffer.from(challenge, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
