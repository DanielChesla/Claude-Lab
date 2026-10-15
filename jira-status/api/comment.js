// POST /api/comment  — add a plain-text comment to a Jira ticket (Vercel Node function, ESM).
//
// Request body:  { "email": "someone@profitsolv.com", "key": "NXT-12345", "text": "..." }
// Responses:     200 { key, commentId }
//                400 bad input · 403 email domain not allowed / comments off · 404 not found
//                429 rate limited · 500 misconfigured · 502 Jira call failed
//
// Jira shows the comment as coming from the service account, so the first line of the comment is a
// bold header naming the real author. Limits live in ../config/comments.json.

import {
  comments as C, clientIp, isAllowedEmail, projectOf, allowedProjects,
  isRateLimited, commentsThisHour, writeLog, logComment,
  jiraClient, lookupByKey, commentAdf,
} from '../lib/jira.js';

const MAX_CHARS = Number(C.maxChars);
const PER_HOUR = Number(C.perEmailPerHour);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const email = String(body?.email || '').trim().toLowerCase().slice(0, 254);
  const key = String(body?.key || '').trim().toUpperCase().slice(0, 32);
  const text = String(body?.text || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  const ip = clientIp((h) => req.headers?.[h], req.socket?.remoteAddress);
  const log = (entry) => writeLog({ ip, email, query: key, queryType: 'comment', ...entry });

  if (C.enabled === false) return res.status(403).json({ error: 'Comments are turned off.' });
  const client = jiraClient(process.env.JIRA_API_TOKEN);
  if (!client) {
    console.error('JIRA_EMAIL / JIRA_API_TOKEN not set');
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  try {
    if (await isRateLimited(ip)) {
      await log({ result: 'rate_limited' });
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
  } catch (err) {
    console.error('rate-limit check failed; allowing request', err);
  }

  if (!isAllowedEmail(email)) {
    await log({ result: 'rejected_domain' });
    return res.status(403).json({ error: 'Access Denied' });
  }
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !allowedProjects.includes(projectOf(key))) {
    await log({ result: 'not_found' });
    return res.status(404).json({ error: 'Not found.' });
  }
  if (!text) return res.status(400).json({ error: 'Enter a comment.' });
  if (text.length > MAX_CHARS) {
    await log({ result: 'rejected_size' });
    return res.status(400).json({ error: `Comment is longer than ${MAX_CHARS} characters.` });
  }

  try {
    if (!(await client.verify())) {
      console.error('Jira rejected JIRA_EMAIL / JIRA_API_TOKEN');
      await log({ result: 'error' });
      return res.status(500).json({ error: 'Server is not configured.' });
    }

    const found = await lookupByKey(client, key);
    if (!found.length) {
      await log({ result: 'not_found' });
      return res.status(404).json({ error: 'Not found.' });
    }

    if ((await commentsThisHour(email)) >= PER_HOUR) {
      await log({ result: 'rate_limited' });
      return res.status(429).json({ error: `Comment limit reached (${PER_HOUR} per hour). Try again later.` });
    }

    const header = String(C.headerTemplate).replace('{email}', email);
    const r = await client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: commentAdf(header, text) });
    if (!r.ok) {
      console.error('Jira comment returned', r.status, (await r.text()).slice(0, 300));
      await logComment({ ip, email, issueKey: key, chars: text.length, result: 'error' });
      await log({ result: 'error', keys: [key] });
      return res.status(502).json({ error: 'Jira rejected the comment. Try again shortly.' });
    }
    const created = await r.json();
    await logComment({ ip, email, issueKey: key, chars: text.length, commentId: String(created.id), result: 'posted' });
    await log({ result: 'posted', keys: [key] });
    return res.status(200).json({ key, commentId: String(created.id) });
  } catch (err) {
    console.error('comment failed', err);
    await log({ result: 'error', keys: [key] });
    return res.status(502).json({ error: 'Comment failed. Try again shortly.' });
  }
}
