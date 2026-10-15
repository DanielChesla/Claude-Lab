// Optional Microsoft Entra ID sign-in for the page.
//
// Off unless ENTRA_TENANT_ID and ENTRA_CLIENT_ID are both set. When on, every API call must carry
// "Authorization: Bearer <ID token>" issued by that tenant for that app registration; the caller's
// email then comes from the verified token instead of the request body. The browser side (MSAL)
// lives in public/index.html and reads /api/auth-config to know whether sign-in is on.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const TENANT = String(process.env.ENTRA_TENANT_ID || '').trim();
const CLIENT = String(process.env.ENTRA_CLIENT_ID || '').trim();
export const ssoEnabled = Boolean(TENANT && CLIENT);
export const authority = ssoEnabled ? `https://login.microsoftonline.com/${TENANT}` : '';

// Test hooks only (point verification at a local issuer/JWKS). Leave unset in real deployments.
const ISSUER = process.env.ENTRA_ISSUER || `${authority}/v2.0`;
const JWKS_URL = process.env.ENTRA_JWKS_URL || `${authority}/discovery/v2.0/keys`;
let jwks = null; // lazily created; jose caches the keys and refetches on unknown kid

export function authConfig() {
  return ssoEnabled ? { enabled: true, clientId: CLIENT, tenantId: TENANT, authority } : { enabled: false };
}

// Verifies an Authorization header. Returns { email, name } or { error, status }.
export async function verifyBearer(authorizationHeader) {
  const m = /^Bearer\s+([A-Za-z0-9_.\-]+)$/i.exec(String(authorizationHeader || '').trim());
  if (!m) return { error: 'Sign in required.', status: 401 };
  try {
    jwks ||= createRemoteJWKSet(new URL(JWKS_URL));
    const { payload } = await jwtVerify(m[1], jwks, { issuer: ISSUER, audience: CLIENT, clockTolerance: 60 });
    if (payload.tid && payload.tid !== TENANT) return { error: 'Sign in required.', status: 401 };
    const email = String(payload.email || payload.preferred_username || '').trim().toLowerCase().slice(0, 254);
    if (!email) return { error: 'Signed-in account has no email address.', status: 403 };
    return { email, name: String(payload.name || '') };
  } catch (err) {
    console.warn('ID token rejected:', err?.code || err?.message);
    return { error: 'Sign in required.', status: 401 };
  }
}

// Who is calling? The verified token when sign-in is on; otherwise the email typed into the page.
// getHeader: (name) => string | undefined (lower-case header names).
export async function callerEmail(getHeader, bodyEmail) {
  if (!ssoEnabled) return { email: String(bodyEmail || '').trim().toLowerCase().slice(0, 254) };
  return verifyBearer(getHeader('authorization'));
}
