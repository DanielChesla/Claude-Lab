// POST /api/lookup  — read-only Jira ticket status lookup (Vercel Node function, ESM).
//
// Request body:  { "email": "someone@profitsolv.com", "query": "NXT-12345" | "00702781" }
// Responses:     200 { queryType, query, results: [issue...] }
//                400 invalid input · 403 email domain not allowed · 404 not found
//                429 rate limited · 500 misconfigured · 502 Jira call failed
//
// Secrets come from environment variables only: JIRA_EMAIL, JIRA_API_TOKEN, DATABASE_URL.
// Everything tunable lives in ../config/*.json.

import { createRequire } from 'node:module';
import { neon } from '@neondatabase/serverless';

const require = createRequire(import.meta.url);
const allowedDomains = require('../config/allowed-domains.json').map((d) => String(d).trim().toLowerCase());
const allowedProjects = require('../config/projects.json').map((p) => String(p).trim().toUpperCase());
const settings = require('../config/settings.json');

// jiraBaseUrl is the site (used for "Open in Jira" links). jiraApiBaseUrl is where REST calls go:
// Atlassian service-account tokens only work through https://api.atlassian.com/ex/jira/<cloudId>,
// not the site hostname. Falls back to the site URL if not set (fine for ordinary user tokens).
const JIRA_BASE = String(settings.jiraBaseUrl).replace(/\/+$/, '');
const API_BASE = String(settings.jiraApiBaseUrl || settings.jiraBaseUrl).replace(/\/+$/, '');
const SF_FIELD = settings.salesforceCaseField;   // e.g. customfield_10158
const SPRINT_FIELD = settings.sprintField;       // e.g. customfield_10020
const RATE_LIMIT = Number(settings.rateLimitPerMinute ?? 30);
const MAX_CASE_MATCHES = Number(settings.maxCaseMatches ?? 20);

const FIELDS = [
  'summary', 'status', 'issuetype', 'priority', 'created', 'updated',
  'fixVersions', 'resolution', 'comment', SPRINT_FIELD, SF_FIELD,
];

// ---------- Postgres (lookup log + rate limit) ----------

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const sql = dbUrl ? neon(dbUrl) : null;
let schemaReady = false;

async function ensureSchema() {
  if (!sql || schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS lookups (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    ip text NOT NULL,
    email text,
    query text,
    query_type text,
    result text NOT NULL,
    matched_keys text[] NOT NULL DEFAULT '{}'
  )`;
  await sql`CREATE INDEX IF NOT EXISTS lookups_ip_created_idx ON lookups (ip, created_at DESC)`;
  schemaReady = true;
}

async function isRateLimited(ip) {
  if (!sql) return false;
  await ensureSchema();
  const rows = await sql`SELECT count(*)::int AS n FROM lookups
                         WHERE ip = ${ip} AND created_at > now() - interval '1 minute'`;
  return (rows[0]?.n ?? 0) >= RATE_LIMIT;
}

async function writeLog(entry) {
  const row = {
    ip: entry.ip, email: entry.email || null, query: entry.query || null,
    queryType: entry.queryType || 'n/a', result: entry.result, keys: entry.keys || [],
  };
  if (!sql) { console.log('lookup', JSON.stringify(row)); return; }
  try {
    await ensureSchema();
    await sql`INSERT INTO lookups (ip, email, query, query_type, result, matched_keys)
              VALUES (${row.ip}, ${row.email}, ${row.query}, ${row.queryType}, ${row.result}, ${row.keys})`;
  } catch (err) {
    console.error('lookup log write failed', err);
  }
}

// ---------- Input handling ----------

function clientIp(req) {
  const h = req.headers || {};
  const fwd = String(h['x-real-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

function classify(raw) {
  const q = String(raw || '').trim();
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(q)) return { type: 'key', value: q.toUpperCase() };
  const compact = q.replace(/[\s-]/g, '');
  if (/^\d{4,12}$/.test(compact)) return { type: 'case', value: compact.padStart(8, '0') };
  return { type: 'invalid', value: q };
}

// ---------- Jira ----------

function authHeader() {
  return 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
}

// Node's fetch sends "Accept-Language: *" by default and Jira then returns translated status and
// issue-type names (observed as Chinese). Always ask for English explicitly.
function jiraHeaders(extra = {}) {
  return {
    Authorization: authHeader(),
    Accept: 'application/json',
    'Accept-Language': settings.acceptLanguage || 'en-US,en;q=0.9',
    ...extra,
  };
}

// Jira Cloud treats a bad API token as an anonymous caller on most endpoints (it answers 404,
// not 401), which would make every lookup look like "Not found". Guard against that two ways:
// verify the credentials once per instance, and reject any response flagged as auth-failed.
function assertAuthenticated(r) {
  const reason = r.headers.get('x-seraph-loginreason') || '';
  if (/AUTHENTICATED_FAILED|AUTHENTICATION_DENIED/i.test(reason)) {
    throw new Error(`Jira rejected the integration credentials (${reason})`);
  }
  return r;
}

let authVerifiedAt = 0;
const AUTH_RECHECK_MS = 10 * 60 * 1000;
async function verifyAuth() {
  if (Date.now() - authVerifiedAt < AUTH_RECHECK_MS) return true;
  const r = await fetch(`${API_BASE}/rest/api/3/myself`, { headers: jiraHeaders() });
  if (!r.ok) return false;
  authVerifiedAt = Date.now();
  return true;
}

async function jiraGet(pathname) {
  const r = await fetch(`${API_BASE}${pathname}`, { headers: jiraHeaders() });
  return assertAuthenticated(r);
}

async function jiraPost(pathname, body) {
  const r = await fetch(`${API_BASE}${pathname}`, {
    method: 'POST',
    headers: jiraHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return assertAuthenticated(r);
}

function projectOf(key) {
  return String(key || '').split('-')[0].toUpperCase();
}

async function lookupByKey(key) {
  if (!allowedProjects.includes(projectOf(key))) return [];
  const r = await jiraGet(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
  if (r.status === 404 || r.status === 403) return [];
  if (!r.ok) throw new Error(`Jira issue fetch returned ${r.status}`);
  const issue = await r.json();
  // Moved issues can redirect to a different project; re-check the key that came back.
  if (!allowedProjects.includes(projectOf(issue.key))) return [];
  return [formatIssue(issue)];
}

async function lookupByCase(caseNumber) {
  const cfId = String(SF_FIELD).replace(/^customfield_/, '');
  // caseNumber is digits-only (validated in classify), so it is safe to inline.
  const jql = `project in (${allowedProjects.join(',')}) AND cf[${cfId}] ~ "${caseNumber}" ORDER BY updated DESC`;
  const r = await jiraPost('/rest/api/3/search/jql', { jql, fields: FIELDS, maxResults: MAX_CASE_MATCHES });
  if (!r.ok) throw new Error(`Jira search returned ${r.status}`);
  const data = await r.json();
  return (data.issues || [])
    .filter((i) => allowedProjects.includes(projectOf(i.key)))
    .map(formatIssue);
}

// Atlassian Document Format -> plain text (links kept as [text](href)).
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  switch (node.type) {
    case 'text': {
      const link = (node.marks || []).find((m) => m.type === 'link');
      return link ? `[${node.text}](${link.attrs?.href || ''})` : (node.text || '');
    }
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text || '';
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'inlineCard': return node.attrs?.url || '';
    case 'media': case 'mediaSingle': case 'mediaGroup': case 'mediaInline': return '[attachment]';
    default: {
      const inner = adfToText(node.content || []);
      const block = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'panel', 'tableRow', 'rule'];
      return block.includes(node.type) ? inner + '\n' : inner;
    }
  }
}

// Salesforce field looks like: "00702781 [view ](https://profitsolv1.my.salesforce.com/500RM...) "
function parseCases(value) {
  if (!value) return [];
  const text = typeof value === 'string' ? value : adfToText(value);
  const out = [];
  const re = /(\d{6,12})\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) out.push({ number: m[1], url: m[2] });
  if (!out.length) for (const n of text.match(/\d{6,12}/g) || []) out.push({ number: n, url: null });
  return out;
}

function formatIssue(issue) {
  const f = issue.fields || {};
  const comments = (f.comment?.comments || []).map((c) => ({
    author: c.author?.displayName || 'Unknown',
    created: c.created,
    body: adfToText(c.body).trim(),
  })).reverse(); // newest first
  return {
    key: issue.key,
    url: `${JIRA_BASE}/browse/${issue.key}`,
    summary: f.summary || '',
    status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.key || '',   // new | indeterminate | done
    type: f.issuetype?.name || '',
    priority: f.priority?.name || '',
    created: f.created || null,
    updated: f.updated || null,
    resolution: f.resolution?.name || null,
    fixVersions: (f.fixVersions || []).map((v) => ({ name: v.name, released: !!v.released, releaseDate: v.releaseDate || null })),
    sprints: (f[SPRINT_FIELD] || []).map((s) => ({ name: s.name, state: s.state })),
    salesforceCases: parseCases(f[SF_FIELD]),
    comments,
  };
}

// ---------- Handler ----------

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
  const ip = clientIp(req);
  const log = (entry) => writeLog({ ip, email, query: rawQuery, ...entry });

  if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
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

  const domain = email.split('@')[1] || '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !allowedDomains.includes(domain)) {
    await log({ result: 'rejected_domain' });
    return res.status(403).json({ error: 'Please use a company email address.' });
  }

  const q = classify(rawQuery);
  if (q.type === 'invalid') {
    await log({ queryType: 'invalid', result: 'invalid' });
    return res.status(400).json({ error: 'Enter a Jira key like NXT-12345 or a Salesforce case number.' });
  }

  try {
    if (!(await verifyAuth())) {
      console.error('Jira rejected JIRA_EMAIL / JIRA_API_TOKEN');
      await log({ queryType: q.type, result: 'error' });
      return res.status(500).json({ error: 'Server is not configured.' });
    }
    const results = q.type === 'key' ? await lookupByKey(q.value) : await lookupByCase(q.value);
    await log({ queryType: q.type, result: results.length ? 'found' : 'not_found', keys: results.map((r) => r.key) });
    if (!results.length) return res.status(404).json({ error: 'Not found.', queryType: q.type, query: q.value });
    return res.status(200).json({ queryType: q.type, query: q.value, results });
  } catch (err) {
    console.error('lookup failed', err);
    await log({ queryType: q.type, result: 'error' });
    return res.status(502).json({ error: 'Jira lookup failed. Try again shortly.' });
  }
}
