// AWS Lambda entry point. Runs the same handlers Vercel runs (../api/*.js) behind an API Gateway
// HTTP API (payload format 2.0). Two handler styles exist and both are adapted here:
//   - Node style:  export default async (req, res)   -> lookup, comment, reopen, auth-config
//   - Web style:   export async function POST(request) -> attach (multipart upload)
// Jira credentials come from one Secrets Manager secret (JIRA_SECRET_ARN, JSON {email, token}) read
// once per cold start and placed in process.env, which is where ../lib/jira.js expects them.

const ROUTES = {
  '/api/lookup': () => import('../api/lookup.js'),
  '/api/comment': () => import('../api/comment.js'),
  '/api/reopen': () => import('../api/reopen.js'),
  '/api/auth-config': () => import('../api/auth-config.js'),
  '/api/attach': () => import('../api/attach.js'),
};

let secretsLoaded = false;
async function loadSecrets() {
  if (secretsLoaded) return;
  const arn = process.env.JIRA_SECRET_ARN;
  if (arn && !process.env.JIRA_API_TOKEN) {
    // The SDK ships inside the Lambda Node runtime; importing it lazily keeps local runs dependency-free.
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
    const s = JSON.parse(out.SecretString || '{}');
    if (s.email) process.env.JIRA_EMAIL = String(s.email);
    if (s.token) process.env.JIRA_API_TOKEN = String(s.token);
  }
  secretsLoaded = true;
}

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export async function handler(event) {
  const method = event.requestContext?.http?.method || 'GET';
  const path = String(event.rawPath || '/').replace(/\/+$/, '') || '/';
  const load = ROUTES[path];
  if (!load) return json(404, { error: 'Not found.' });

  try {
    await loadSecrets();
  } catch (err) {
    console.error('could not read Jira secret', err);
    return json(500, { error: 'Server is not configured.' });
  }

  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;
  const rawBody = event.body == null ? '' : (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body);
  const mod = await load();

  // Web-standard handler (attach): rebuild a Request and translate the Response.
  if (!mod.default && typeof mod.POST === 'function') {
    if (method !== 'POST') return { statusCode: 405, headers: { allow: 'POST', 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    const url = `https://${headers.host || 'localhost'}${event.rawPath}${event.rawQueryString ? '?' + event.rawQueryString : ''}`;
    const request = new Request(url, { method, headers, body: rawBody, duplex: 'half' });
    const response = await mod.POST(request);
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }

  // Node-style handler: minimal req/res with the members the functions use.
  const req = {
    method, headers,
    body: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody,
    socket: { remoteAddress: event.requestContext?.http?.sourceIp },
  };
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.headers['content-type'] = 'application/json'; this.body = JSON.stringify(b); return this; },
  };
  await mod.default(req, res);
  return { statusCode: res.statusCode, headers: res.headers, body: res.body };
}
