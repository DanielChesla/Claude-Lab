// POST /api/attach  — upload one or more files to a Jira ticket (Vercel Node function, Web-standard handler).
//
// multipart/form-data fields:  email, key, file (repeatable)
// Responses: 200 { key, attached: [{id, filename, size}], commentPosted }
//            400 bad input · 403 email domain not allowed · 404 not found · 413 file too large
//            429 rate limited · 500 misconfigured · 502 Jira call failed
//
// Uses JIRA_API_TOKEN, which needs read + write scopes (the ticket is verified before anything is
// uploaded). Jira shows the upload as coming from the service account, so a comment naming the
// real uploader is posted after a successful upload. Limits and the on/off switch live in
// ../config/uploads.json. Vercel caps request bodies at 4.5 MB regardless.

import {
  uploads as U, clientIp, isAllowedEmail, projectOf, allowedProjects,
  isRateLimited, uploadsThisHour, writeLog, logUpload,
  jiraClient, lookupByKey, textToAdf,
} from '../lib/jira.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const MAX_BYTES = Number(U.maxFileBytes);
const MAX_FILES = Number(U.maxFilesPerRequest);
const ALLOWED_EXT = U.allowedExtensions.map((e) => String(e).toLowerCase().replace(/^\./, ''));
const PER_HOUR = Number(U.perEmailPerHour);

function safeName(name) {
  // Drop any path, control characters, and leading dots; keep it readable and bounded.
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').trim();
  return base.slice(0, 200) || 'upload';
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export async function POST(request) {
  const ip = clientIp((h) => request.headers.get(h));

  let form;
  try { form = await request.formData(); } catch { return json(400, { error: 'Expected multipart form data.' }); }

  const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 254);
  const key = String(form.get('key') || '').trim().toUpperCase().slice(0, 32);
  const files = form.getAll('file').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
  const log = (entry) => writeLog({ ip, email, query: key, queryType: 'upload', ...entry });

  if (U.enabled === false) return json(403, { error: 'Uploads are turned off.' });
  const client = jiraClient(process.env.JIRA_API_TOKEN);
  if (!client) {
    console.error('JIRA_EMAIL / JIRA_API_TOKEN not set');
    return json(500, { error: 'Uploads are not configured.' });
  }

  try {
    if (await isRateLimited(ip)) {
      await log({ result: 'rate_limited' });
      return json(429, { error: 'Too many requests. Try again in a minute.' });
    }
  } catch (err) {
    console.error('rate-limit check failed; allowing request', err);
  }

  if (!isAllowedEmail(email)) {
    await log({ result: 'rejected_domain' });
    return json(403, { error: 'Please use a company email address.' });
  }

  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !allowedProjects.includes(projectOf(key))) {
    await log({ result: 'not_found' });
    return json(404, { error: 'Not found.' });
  }

  if (!files.length) return json(400, { error: 'Choose at least one file.' });
  if (files.length > MAX_FILES) return json(400, { error: `At most ${MAX_FILES} files per upload.` });
  for (const f of files) {
    const name = safeName(f.name);
    if (!ALLOWED_EXT.includes(extOf(name))) {
      await log({ result: 'rejected_type' });
      return json(400, { error: `"${name}" is not an allowed file type. Allowed: ${ALLOWED_EXT.join(', ')}.` });
    }
    if (!f.size) return json(400, { error: `"${name}" is empty.` });
    if (f.size > MAX_BYTES) {
      await log({ result: 'rejected_size' });
      return json(413, { error: `"${name}" is larger than ${Math.round(MAX_BYTES / 1048576)} MB.` });
    }
  }

  try {
    if (!(await client.verify())) {
      console.error('Jira rejected JIRA_EMAIL / JIRA_API_TOKEN');
      await log({ result: 'error' });
      return json(500, { error: 'Uploads are not configured.' });
    }

    // Confirm the ticket exists and is in an allowed project before sending anything.
    const found = await lookupByKey(client, key);
    if (!found.length) {
      await log({ result: 'not_found' });
      return json(404, { error: 'Not found.' });
    }

    const used = await uploadsThisHour(email);
    if (used + files.length > PER_HOUR) {
      await log({ result: 'rate_limited' });
      return json(429, { error: `Upload limit reached (${PER_HOUR} files per hour). Try again later.` });
    }

    const fd = new FormData();
    for (const f of files) {
      fd.append('file', new Blob([await f.arrayBuffer()], { type: f.type || 'application/octet-stream' }), safeName(f.name));
    }
    const r = await client.postForm(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, fd);
    if (!r.ok) {
      console.error('Jira attachment upload returned', r.status, (await r.text()).slice(0, 300));
      for (const f of files) await logUpload({ ip, email, issueKey: key, filename: safeName(f.name), sizeBytes: f.size, result: 'error' });
      await log({ result: 'error', keys: [key] });
      return json(502, { error: 'Jira rejected the upload. Try again shortly.' });
    }
    const attached = (await r.json()).map((a) => ({ id: String(a.id), filename: a.filename, size: Number(a.size) }));
    for (const a of attached) await logUpload({ ip, email, issueKey: key, filename: a.filename, sizeBytes: a.size, attachmentId: a.id, result: 'uploaded' });

    // Attribution comment; failure here is reported but does not undo the upload.
    let commentPosted = false;
    try {
      const text = String(U.commentTemplate)
        .replace('{filenames}', attached.map((a) => a.filename).join(', '))
        .replace('{email}', email);
      const c = await client.post(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: textToAdf(text) });
      commentPosted = c.ok;
      if (!c.ok) console.error('attribution comment failed', c.status);
    } catch (err) {
      console.error('attribution comment failed', err);
    }

    await log({ result: 'uploaded', keys: [key] });
    return json(200, { key, attached, commentPosted });
  } catch (err) {
    console.error('upload failed', err);
    await log({ result: 'error', keys: [key] });
    return json(502, { error: 'Upload failed. Try again shortly.' });
  }
}
