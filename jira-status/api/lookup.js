// POST /api/lookup  — read-only Jira ticket status lookup (Vercel Node function, ESM).
//
// Request body:  { "email": "someone@profitsolv.com", "query": "NXT-12345" | "00702781" }
// Responses:     200 { queryType, query, results: [issue...], uploads: {...rules} }
//                400 invalid input · 403 email domain not allowed · 404 not found
//                429 rate limited · 500 misconfigured · 502 Jira call failed
//
// Shared logic lives in ../lib/jira.js.

import {
  clientIp, isAllowedEmail, classify, isRateLimited, writeLog,
  jiraClient, lookupByKey, lookupByCase, uploadRules, commentRules, reopenRules,
} from '../lib/jira.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String(body?.email || '').trim().toLowerCase().slice(0, 254);
  const rawQuery = String(body?.query || '').trim().slice(0, 64);
  const ip = clientIp((h) => req.headers?.[h], req.socket?.remoteAddress);
  const log = (entry) => writeLog({ ip, email, query: rawQuery, ...entry });

  const client = jiraClient(process.env.JIRA_API_TOKEN);
  if (!client) {
    console.error('JIRA_EMAIL / JIRA_API_TOKEN not set');
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  try {
    if (await isRateLimited(ip)) {
      await log({ result: 'rate_limited' });
      return res.status(429).json({ error: 'Too many lookups. Try again in a minute.' });
    }
  } catch (err) {
    console.error('rate-limit check failed; allowing request', err);
  }

  if (!isAllowedEmail(email)) {
    await log({ result: 'rejected_domain' });
    return res.status(403).json({ error: 'Please use a company email address.' });
  }

  const q = classify(rawQuery);
  if (q.type === 'invalid') {
    await log({ queryType: 'invalid', result: 'invalid' });
    return res.status(400).json({ error: 'Enter a Jira key like NXT-12345 or a Salesforce case number.' });
  }

  try {
    if (!(await client.verify())) {
      console.error('Jira rejected JIRA_EMAIL / JIRA_API_TOKEN');
      await log({ queryType: q.type, result: 'error' });
      return res.status(500).json({ error: 'Server is not configured.' });
    }
    const results = q.type === 'key' ? await lookupByKey(client, q.value) : await lookupByCase(client, q.value);
    await log({ queryType: q.type, result: results.length ? 'found' : 'not_found', keys: results.map((r) => r.key) });
    if (!results.length) return res.status(404).json({ error: 'Not found.', queryType: q.type, query: q.value });
    return res.status(200).json({ queryType: q.type, query: q.value, results, uploads: uploadRules(), comments: commentRules(), reopen: reopenRules() });
  } catch (err) {
    console.error('lookup failed', err);
    await log({ queryType: q.type, result: 'error' });
    return res.status(502).json({ error: 'Jira lookup failed. Try again shortly.' });
  }
}
