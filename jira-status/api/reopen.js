// POST /api/reopen  — ask for a closed ticket to be reopened (Vercel Node function, ESM).
//
// Request body:  { "email": "someone@profitsolv.com", "key": "NXT-12345", "reason": "..." }
// Responses:     200 { key, commentId, labelAdded }
//                400 bad input · 403 domain not allowed / feature off · 404 not found
//                409 ticket not in a reopenable status, or a request is already pending
//                429 rate limited · 500 misconfigured · 502 Jira call failed
//
// The ticket's status is never changed here. The function posts a comment whose first line is a
// bold header naming the requestor, then adds the label from config/reopen.json. A Jira Automation
// rule (see README) watches for that comment and emails the assignee (or reporter) with the key,
// requestor and reason.

import {
  reopen as R, clientIp, isAllowedEmail, projectOf, allowedProjects,
  isRateLimited, reopensThisHour, writeLog, logReopen,
  jiraClient, lookupByKey, commentAdf,
} from '../lib/jira.js';

const MAX_CHARS = Number(R.maxChars);
const PER_HOUR = Number(R.perEmailPerHour);
const STATUSES = R.statuses.map((s) => String(s).toLowerCase());
const LABEL = String(R.label);

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
  const reason = String(body?.reason || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  const ip = clientIp((h) => req.headers?.[h], req.socket?.remoteAddress);
  const log = (entry) => writeLog({ ip, email, query: key, queryType: 'reopen', ...entry });

  if (R.enabled === false) return res.status(403).json({ error: 'Reopen requests are turned off.' });
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
    return res.status(403).json({ error: 'Please use a company email address.' });
  }
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !allowedProjects.includes(projectOf(key))) {
    await log({ result: 'not_found' });
    return res.status(404).json({ error: 'Not found.' });
  }
  if (!reason) return res.status(400).json({ error: 'Enter a reason.' });
  if (reason.length > MAX_CHARS) {
    await log({ result: 'rejected_size' });
    return res.status(400).json({ error: `Reason is longer than ${MAX_CHARS} characters.` });
  }

  try {
    if (!(await client.verify())) {
      console.error('Jira rejected JIRA_EMAIL / JIRA_API_TOKEN');
      await log({ result: 'error' });
      return res.status(500).json({ error: 'Server is not configured.' });
    }

    const [issue] = await lookupByKey(client, key);
    if (!issue) {
      await log({ result: 'not_found' });
      return res.status(404).json({ error: 'Not found.' });
    }
    if (!STATUSES.includes(String(issue.status).toLowerCase())) {
      await log({ result: 'wrong_status', keys: [key] });
      return res.status(409).json({ error: `${key} is in status "${issue.status}", which can't be reopened from here.` });
    }
    if (issue.labels.includes(LABEL)) {
      await log({ result: 'already_pending', keys: [key] });
      return res.status(409).json({ error: `A reopen request for ${key} is already pending.` });
    }
    if ((await reopensThisHour(email)) >= PER_HOUR) {
      await log({ result: 'rate_limited' });
      return res.status(429).json({ error: `Reopen request limit reached (${PER_HOUR} per hour). Try again later.` });
    }

    // 1) Comment (this is what the Automation rule triggers on, so it carries requestor + reason).
    const header = String(R.headerTemplate).replace('{email}', email);
    const c = await client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: commentAdf(header, reason) });
    if (!c.ok) {
      console.error('Jira reopen comment returned', c.status, (await c.text()).slice(0, 300));
      await logReopen({ ip, email, issueKey: key, status: issue.status, chars: reason.length, result: 'error' });
      await log({ result: 'error', keys: [key] });
      return res.status(502).json({ error: 'Jira rejected the request. Try again shortly.' });
    }
    const commentId = String((await c.json()).id);

    // 2) Label, so pending requests are visible/filterable and repeat clicks are blocked.
    let labelAdded = false;
    try {
      const l = await client.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: [{ add: LABEL }] } });
      labelAdded = l.ok;
      if (!l.ok) console.error('Jira label add returned', l.status, (await l.text()).slice(0, 300));
    } catch (err) {
      console.error('Jira label add failed', err);
    }

    await logReopen({ ip, email, issueKey: key, status: issue.status, chars: reason.length, commentId, labelAdded, result: 'requested' });
    await log({ result: 'requested', keys: [key] });
    return res.status(200).json({ key, commentId, labelAdded });
  } catch (err) {
    console.error('reopen failed', err);
    await log({ result: 'error', keys: [key] });
    return res.status(502).json({ error: 'Request failed. Try again shortly.' });
  }
}
