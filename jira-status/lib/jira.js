// Shared code for the Vercel functions: config, Postgres log + rate limits, Jira client, issue formatting.
// Secrets come from environment variables only: JIRA_EMAIL, JIRA_API_TOKEN (read + write scopes),
// DATABASE_URL. Everything tunable lives in ../config/*.json.

import { createRequire } from 'node:module';
import { neon } from '@neondatabase/serverless';

const require = createRequire(import.meta.url);
export const allowedDomains = require('../config/allowed-domains.json').map((d) => String(d).trim().toLowerCase());
export const allowedProjects = require('../config/projects.json').map((p) => String(p).trim().toUpperCase());
export const settings = require('../config/settings.json');
export const uploads = require('../config/uploads.json');
export const comments = require('../config/comments.json');

// jiraBaseUrl is the site (used for "Open in Jira" links). jiraApiBaseUrl is where REST calls go:
// Atlassian service-account tokens only work through https://api.atlassian.com/ex/jira/<cloudId>,
// not the site hostname. Falls back to the site URL if not set (fine for ordinary user tokens).
export const JIRA_BASE = String(settings.jiraBaseUrl).replace(/\/+$/, '');
export const API_BASE = String(settings.jiraApiBaseUrl || settings.jiraBaseUrl).replace(/\/+$/, '');
export const SF_FIELD = settings.salesforceCaseField;   // e.g. customfield_10158
export const SPRINT_FIELD = settings.sprintField;       // e.g. customfield_10020
export const RATE_LIMIT = Number(settings.rateLimitPerMinute ?? 30);
export const MAX_CASE_MATCHES = Number(settings.maxCaseMatches ?? 20);

export const FIELDS = [
  'summary', 'description', 'status', 'issuetype', 'priority', 'created', 'updated',
  'fixVersions', 'resolution', 'comment', SPRINT_FIELD, SF_FIELD,
];

// ---------- Postgres (lookup log + rate limits) ----------

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const sql = dbUrl ? neon(dbUrl) : null;
let schemaReady = false;

export async function ensureSchema() {
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
  await sql`CREATE TABLE IF NOT EXISTS uploads (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    ip text NOT NULL,
    email text NOT NULL,
    issue_key text NOT NULL,
    filename text NOT NULL,
    size_bytes bigint NOT NULL,
    attachment_id text,
    result text NOT NULL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS uploads_email_created_idx ON uploads (email, created_at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS comments (
    id bigserial PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    ip text NOT NULL,
    email text NOT NULL,
    issue_key text NOT NULL,
    chars int NOT NULL,
    comment_id text,
    result text NOT NULL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS comments_email_created_idx ON comments (email, created_at DESC)`;
  schemaReady = true;
}

export async function commentsThisHour(email) {
  if (!sql) return 0;
  await ensureSchema();
  const rows = await sql`SELECT count(*)::int AS n FROM comments
                         WHERE email = ${email} AND result = 'posted' AND created_at > now() - interval '1 hour'`;
  return rows[0]?.n ?? 0;
}

export async function logComment(row) {
  if (!sql) { console.log('comment', JSON.stringify(row)); return; }
  try {
    await ensureSchema();
    await sql`INSERT INTO comments (ip, email, issue_key, chars, comment_id, result)
              VALUES (${row.ip}, ${row.email}, ${row.issueKey}, ${row.chars}, ${row.commentId || null}, ${row.result})`;
  } catch (err) {
    console.error('comment log write failed', err);
  }
}

// Per-IP limit across all requests (lookups and uploads both write to lookups).
export async function isRateLimited(ip) {
  if (!sql) return false;
  await ensureSchema();
  const rows = await sql`SELECT count(*)::int AS n FROM lookups
                         WHERE ip = ${ip} AND created_at > now() - interval '1 minute'`;
  return (rows[0]?.n ?? 0) >= RATE_LIMIT;
}

export async function uploadsThisHour(email) {
  if (!sql) return 0;
  await ensureSchema();
  const rows = await sql`SELECT count(*)::int AS n FROM uploads
                         WHERE email = ${email} AND result = 'uploaded' AND created_at > now() - interval '1 hour'`;
  return rows[0]?.n ?? 0;
}

export async function writeLog(entry) {
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

export async function logUpload(row) {
  if (!sql) { console.log('upload', JSON.stringify(row)); return; }
  try {
    await ensureSchema();
    await sql`INSERT INTO uploads (ip, email, issue_key, filename, size_bytes, attachment_id, result)
              VALUES (${row.ip}, ${row.email}, ${row.issueKey}, ${row.filename}, ${row.sizeBytes}, ${row.attachmentId || null}, ${row.result})`;
  } catch (err) {
    console.error('upload log write failed', err);
  }
}

// ---------- Input handling ----------

// getHeader: (name) => string | undefined. Works for Node req.headers and Web Request headers.
export function clientIp(getHeader, fallback = 'unknown') {
  const fwd = String(getHeader('x-real-ip') || getHeader('x-forwarded-for') || '').split(',')[0].trim();
  return fwd || fallback;
}

export function isAllowedEmail(email) {
  const domain = String(email).split('@')[1] || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && allowedDomains.includes(domain);
}

export function classify(raw) {
  const q = String(raw || '').trim();
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(q)) return { type: 'key', value: q.toUpperCase() };
  const compact = q.replace(/[\s-]/g, '');
  if (/^\d{4,12}$/.test(compact)) return { type: 'case', value: compact.padStart(8, '0') };
  return { type: 'invalid', value: q };
}

export function projectOf(key) {
  return String(key || '').split('-')[0].toUpperCase();
}

// ---------- Jira client ----------

// Jira Cloud treats a bad API token as an anonymous caller on most endpoints (it answers 404,
// not 401), which would make every lookup look like "Not found". Guard against that two ways:
// verify the credentials once per instance (per token), and reject any response flagged as auth-failed.
function assertAuthenticated(r) {
  const reason = r.headers.get('x-seraph-loginreason') || '';
  if (/AUTHENTICATED_FAILED|AUTHENTICATION_DENIED/i.test(reason)) {
    throw new Error(`Jira rejected the integration credentials (${reason})`);
  }
  return r;
}

const AUTH_RECHECK_MS = 10 * 60 * 1000;
const verifiedAt = new Map(); // token -> timestamp

export function jiraClient(token) {
  if (!process.env.JIRA_EMAIL || !token) return null;
  const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_EMAIL}:${token}`).toString('base64');
  // Node's fetch sends "Accept-Language: *" by default and Jira then returns translated status and
  // issue-type names (observed as Chinese). Always ask for English explicitly.
  const headers = (extra = {}) => ({
    Authorization: auth,
    Accept: 'application/json',
    'Accept-Language': settings.acceptLanguage || 'en-US,en;q=0.9',
    ...extra,
  });
  return {
    async verify() {
      if (Date.now() - (verifiedAt.get(token) || 0) < AUTH_RECHECK_MS) return true;
      const r = await fetch(`${API_BASE}/rest/api/3/myself`, { headers: headers() });
      if (!r.ok) return false;
      verifiedAt.set(token, Date.now());
      return true;
    },
    async get(pathname) {
      return assertAuthenticated(await fetch(`${API_BASE}${pathname}`, { headers: headers() }));
    },
    async post(pathname, body) {
      return assertAuthenticated(await fetch(`${API_BASE}${pathname}`, {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
      }));
    },
    // multipart upload; fetch sets the multipart Content-Type boundary itself.
    async postForm(pathname, formData) {
      return assertAuthenticated(await fetch(`${API_BASE}${pathname}`, {
        method: 'POST', headers: headers({ 'X-Atlassian-Token': 'no-check' }), body: formData,
      }));
    },
  };
}

export async function lookupByKey(client, key) {
  if (!allowedProjects.includes(projectOf(key))) return [];
  const r = await client.get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
  if (r.status === 404 || r.status === 403) return [];
  if (!r.ok) throw new Error(`Jira issue fetch returned ${r.status}`);
  const issue = await r.json();
  // Moved issues can redirect to a different project; re-check the key that came back.
  if (!allowedProjects.includes(projectOf(issue.key))) return [];
  return [formatIssue(issue)];
}

export async function lookupByCase(client, caseNumber) {
  const cfId = String(SF_FIELD).replace(/^customfield_/, '');
  // caseNumber is digits-only (validated in classify), so it is safe to inline.
  const jql = `project in (${allowedProjects.join(',')}) AND cf[${cfId}] ~ "${caseNumber}" ORDER BY updated DESC`;
  const r = await client.post('/rest/api/3/search/jql', { jql, fields: FIELDS, maxResults: MAX_CASE_MATCHES });
  if (!r.ok) throw new Error(`Jira search returned ${r.status}`);
  const data = await r.json();
  return (data.issues || [])
    .filter((i) => allowedProjects.includes(projectOf(i.key)))
    .map(formatIssue);
}

// ---------- Formatting ----------

// Atlassian Document Format -> plain text (links kept as [text](href)).
export function adfToText(node) {
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

export function textToAdf(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text) }] }] };
}

// Bold header line, then the user's text as paragraphs (blank-line separated, line breaks kept).
export function commentAdf(header, text) {
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const content = [{ type: 'paragraph', content: [{ type: 'text', text: String(header), marks: [{ type: 'strong' }] }] }];
  for (const p of paragraphs) {
    const nodes = [];
    p.split('\n').forEach((line, i) => {
      if (i) nodes.push({ type: 'hardBreak' });
      if (line) nodes.push({ type: 'text', text: line });
    });
    content.push({ type: 'paragraph', content: nodes });
  }
  return { type: 'doc', version: 1, content };
}

// Salesforce field looks like: "00702781 [view ](https://profitsolv1.my.salesforce.com/500RM...) "
// or, on some projects, an ADF paragraph containing just the number.
export function parseCases(value) {
  if (!value) return [];
  const text = typeof value === 'string' ? value : adfToText(value);
  const out = [];
  const re = /(\d{6,12})\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) out.push({ number: m[1], url: m[2] });
  if (!out.length) for (const n of text.match(/\d{6,12}/g) || []) out.push({ number: n, url: null });
  return out;
}

export function formatIssue(issue) {
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
    description: adfToText(f.description).trim(),
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

// What the page needs to know about upload and comment rules (no secrets).
export function uploadRules() {
  return {
    enabled: uploads.enabled !== false && !!process.env.JIRA_API_TOKEN,
    maxFileBytes: Number(uploads.maxFileBytes),
    maxFilesPerRequest: Number(uploads.maxFilesPerRequest),
    allowedExtensions: uploads.allowedExtensions,
  };
}

export function commentRules() {
  return {
    enabled: comments.enabled !== false && !!process.env.JIRA_API_TOKEN,
    maxChars: Number(comments.maxChars),
  };
}
