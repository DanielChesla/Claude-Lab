// GET /api/auth-config — tells the browser whether Microsoft sign-in is on and, if so, the public
// client/tenant ids it needs for MSAL. Nothing secret is returned.

import { authConfig } from '../lib/auth.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(authConfig());
}
