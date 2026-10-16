# Jira Ticket Status

**Live:** https://jira-status.profitsolv.com — company AWS account (SAM stack `jira-status`,
see "Deploying to AWS" below), source in `profitsolv-team/jira-status`. The original Vercel copy at
https://jira-status-seven.vercel.app still runs from `DanielChesla/Claude-Lab` until it is retired.

Read-only web page for ProfitSolv staff to check the status of a Jira ticket by key
(`NXT-12345`) or by Salesforce case number (`00702781`), without needing a Jira license
themselves. Runs on Vercel: a static page plus one Node serverless function that calls the
Jira Cloud REST API with a dedicated integration account.

```
public/index.html          the page
api/lookup.js              POST /api/lookup — validates, queries Jira, logs
api/attach.js              POST /api/attach — uploads files to a ticket + attribution comment
api/comment.js             POST /api/comment — adds a plain-text comment with an author header
api/reopen.js              POST /api/reopen — comment + label asking for a closed ticket to be reopened
lib/jira.js                shared config loading, request logging, Jira client, formatting
aws/handler.mjs            AWS Lambda entry point (adapts API Gateway events to the handlers above)
template.yaml, samconfig.toml, aws/deploy.sh   AWS SAM stack and deploy script (see "Deploying to AWS")
config/allowed-domains.json  email domains allowed to use the page
config/projects.json         Jira project keys that can be looked up
config/settings.json         Jira base URL, field IDs, max results per case
config/uploads.json          upload size cap, file count, allowed extensions, attribution comment
config/comments.json         comment length cap, author header text
config/reopen.json           statuses that allow a reopen request, label, reason cap
```

## How it works

1. User enters an email and a key or case number.
2. The function rejects the request unless the email's domain is in `allowed-domains.json`.
3. Key → `GET /rest/api/3/issue/{key}`, only if the key's project is in `projects.json`.
   Case number → JQL `project in (...) AND cf[10158] ~ "00702781"` via `POST /rest/api/3/search/jql`.
4. Anything outside the allowed projects, missing, or not visible to the integration user
   returns a generic **Not found**.
5. Every request is written to the function log as one JSON line (timestamp, event, IP, email,
   query, result, matched keys). There is no database; the platform's log store is the audit trail.

Shown per ticket: status (with Jira category colour), summary, type, priority, resolution,
fix versions, sprint, linked Salesforce case(s), created/updated, the description (collapsed),
and all comments (newest first, collapsed). Each key links to Jira for licensed users.

### Attachments

Each result card has an **Add attachment** section. The browser posts `email`, `key` and one or
more `file` parts to `/api/attach`, which:

1. Applies the same email-domain and per-IP checks as lookups.
2. Rejects anything outside `config/uploads.json`: max 5 files, 4 MB each, allowed extensions only.
   Vercel itself refuses request bodies over 4.5 MB, which is why the cap is 4 MB.
3. Confirms the ticket exists in an allowed project (generic "Not found" otherwise).
4. Uploads via `POST /rest/api/3/issue/{key}/attachments`.
5. Posts a comment on the ticket naming the uploader, since Jira shows the file as uploaded by the
   service account. The text is `commentTemplate` in `config/uploads.json`.
7. Logs one `uploads` row per file and one `lookups` row (query_type `upload`) per request.

Set `"enabled": false` in `config/uploads.json` to hide the upload section and refuse uploads.

### Comments

Each result card also has an **Add comment** box. The browser posts `email`, `key` and `text` to
`/api/comment`, which applies the same domain, IP, project and ticket-existence checks, enforces
`config/comments.json` (2,000 characters), and
posts the comment via `POST /rest/api/3/issue/{key}/comment`. The first line of the comment is a
bold header from `headerTemplate` ("Comment from someone@profitsolv.com via the Jira status
page"), followed by the user's text as plain paragraphs. Every attempt is logged. Set `"enabled": false` to hide the box and refuse comments.

### Reopen requests

When a ticket's status is one of the names in `config/reopen.json` (`Done`, `Deployed to
Production`), the card shows **Request ticket be reopened**. Clicking it reveals a reason box.
Submitting posts to `/api/reopen`, which, after the usual checks:

1. Re-reads the ticket and refuses (409) if the status is not in the list or the ticket already
   carries the `reopen-requested` label ("already pending").
2. Enforces a 1,000-character reason.
3. Posts a comment whose bold first line is "Reopen requested by someone@profitsolv.com via the
   Jira status page for NXT-12345 (Done) https://profitsolv.atlassian.net/browse/NXT-12345",
   followed by the reason. Key, status and link are in the comment on purpose: the email rule only
   needs `{{comment.body}}`.
4. Adds the `reopen-requested` label (needs Edit Issues on the project).
5. Logs the request.

**The status is never changed by the page.** Reopening remains an engineering decision.

The email to the assignee is sent by a **Jira Automation rule**, not by the page. Create it once
(Jira → Automation → Create rule) with:

- **Trigger:** Issue commented.
- **Condition:** Comment → *Comment body contains* `Reopen requested by`. Optionally also
  *Issue fields condition* → Labels contains `reopen-requested`.
- **If / else block:**
  - *If* Assignee is not empty → **Send email**, To: `{{issue.assignee.emailAddress}}`.
  - *Else* → **Send email**, To: `{{issue.reporter.emailAddress}}`.
- **Email subject:** `Reopen requested: {{issue.key}} {{issue.summary}}` (if `{{issue.…}}` does not
  render in your builder, use the fixed subject `Reopen requested on a Jira ticket`).
- **Email body:** keep it to the one smart value that renders in every builder:

  ```
  A support rep has asked for a ticket to be reopened. Details, requestor and reason:

  {{comment.body}}

  Remove the "reopen-requested" label on the ticket once you have acted on it.
  ```

  The comment's first line already contains the ticket key, its status, a link, and the
  requestor's email, so nothing else is needed from the issue.

- Scope the rule to the four projects in `config/projects.json`. Actor can stay as Automation for
  Jira.

Removing the `reopen-requested` label (or changing the status) lets the page accept a new request
for that ticket. Set `"enabled": false` in `config/reopen.json` to hide the button and refuse
requests.

## One-time setup

### 1. Jira service account

The page authenticates as an **Atlassian service account** created in Atlassian Administration
(Directory → Service accounts). It has no mailbox and no interactive login; the org admin
generates its API token. It still needs Jira product access, so **it consumes one Jira seat.**

Current account: `jira-status-devqmzo9cd@serviceaccount.atlassian.com` (account type `app`).

Two things that are specific to service accounts:

- Their tokens only work through the API gateway, `https://api.atlassian.com/ex/jira/<cloudId>`,
  not the site hostname. That gateway URL is `jiraApiBaseUrl` in `config/settings.json`; the site
  URL (`jiraBaseUrl`) is used only for "Open in Jira" links. The cloudId for profitsolv.atlassian.net
  is `ad53d5b5-76e6-413c-b6dc-7289a2e6082d`.
- Basic auth is still used: username = the service account's `@serviceaccount.atlassian.com`
  address, password = the token.

**Permissions.** The account should have **Browse Projects** only, and only on the projects in
`config/projects.json`. When first tested it could browse 90 projects because default project
roles grant Browse to any logged-in user. The app's allow-list hides the rest, but to make the
account itself least-privilege, remove it from any default groups and grant Browse via a
dedicated project role (for example "Status Reader") on NXT, MGDEV, MGSHR, and TS. It needs no
Create, Edit, Comment, Transition, or Attach permissions. If internal comments should be hidden,
restrict those comments to a role or group the account is not in.

**Token.** Generated by an org admin on the service account's page in Atlassian Administration.
One token, `JIRA_API_TOKEN`, with both read and write scopes: `read:jira-work`, `read:jira-user`,
and `write:jira-work` (attachments and comments). Scopes are fixed at creation; to change them,
create a new token and replace the variable. Two failure modes seen while setting this up, both
reported by Jira as `401 Unauthorized; scope does not match`:

- A write-only token (no read scopes) fails the identity check and every lookup.
- Mixing classic read scopes with granular write scopes (`write:attachment:jira`,
  `write:comment:jira`) fails every write, because each granular endpoint needs its complete
  granular scope set. Stay in the classic family. Store the token only in Vercel
environment variables (step 3) and in a local `.env.local` for development. Note that
`vercel link` and `vercel integration add` rewrite `.env.local` and drop variables that only exist
in Production/Preview, so keep the Jira variables in the Development environment too.

### 2. Logging

There is no database. Each request writes one JSON line to stdout, which Vercel keeps in the
function logs (CloudWatch Logs on AWS). Fields: `ts`, `event` (lookup / comment / upload /
reopen), `ip`, `email`, `query`, `result`, `keys`, plus event-specific details such as
`commentId` or `files`. Identity comes from Microsoft sign-in, so per-user rate limits were
dropped; if abuse ever appears, add throttling at the edge (Vercel WAF or API Gateway).

### 3. Vercel project and environment variables

1. Push this folder to GitHub and import it in Vercel (framework preset: **Other**).
   Root directory: the `jira-status` folder.
2. Settings → Environment Variables (Production and Preview):
   - `JIRA_EMAIL` — the service account's email
   - `JIRA_API_TOKEN` — the read+write token from step 1
3. Deploy. The page is at `/`, the API at `/api/lookup`.

## Microsoft sign-in (optional)

By default the page gates on a typed company email. Setting two environment variables switches it
to real Microsoft Entra ID sign-in:

- `ENTRA_TENANT_ID` — the Legal Brands tenant, `0e1c4cb5-74f3-4ce0-b40e-801d3d150eb9`
  (profitsolv.com, mangopractice.com and lawruler.com all live in it).
- `ENTRA_CLIENT_ID` — the Application (client) ID of the App Registration below.

With both set, `/api/auth-config` reports sign-in as on; the page hides the email box, loads MSAL
from jsDelivr, signs the user in silently (on a managed Windows device the browser already holds the
work account, so there is normally no prompt) or redirects to the Microsoft login, and sends the ID
token as `Authorization: Bearer …` on every API call. `lib/auth.js` verifies the token's signature
against the tenant's published keys, its issuer, audience and expiry, and takes the caller's email
from the token. The email-domain allow-list still applies afterwards as a second check. Remove the
two variables and redeploy to fall back to the typed-email gate.

### App Registration (IT)

In the Entra admin center, **App registrations → New registration**:

1. Name: `Jira Ticket Status Page`.
2. Supported account types: **Accounts in this organizational directory only** (single tenant).
3. Authentication → Add a platform → **Single-page application**. Redirect URIs:
   `https://jira-status.profitsolv.com/`, `https://jira-status-seven.vercel.app/` (until Vercel is
   retired) and `http://localhost:3000/` (local dev). Leave both
   implicit-grant boxes unchecked; the page uses PKCE.
4. Certificates & secrets: none. The browser signs in directly; no client secret exists anywhere.
5. API permissions: Microsoft Graph → Delegated → `openid`, `profile`, `email`, `User.Read`
   (the defaults). **Grant admin consent** so users never see a consent prompt.
6. Token configuration → Add optional claim → ID → `email`.
7. Optional: in **Enterprise applications** open the same app and set *Assignment required* to Yes,
   then assign the support group. Otherwise anyone in the tenant can sign in (the domain allow-list
   still applies).

Copy the Application (client) ID into `ENTRA_CLIENT_ID` in Vercel (Production, and Preview if you
want preview deployments to use it) and redeploy.

Notes:

- Preview deployments have changing URLs, so sign-in only works on URLs listed as redirect URIs.
  Either leave the two variables out of the Preview environment, or add a stable preview alias as
  a redirect URI.
- The ID token lives in the browser's sessionStorage for the tab; closing the tab signs out.
- `ENTRA_ISSUER` and `ENTRA_JWKS_URL` exist only so the verifier can be tested against a local
  issuer. Leave them unset.

## Deploying to AWS (SAM)

The same code runs on AWS without changes to `api/` or `lib/`. `aws/handler.mjs` adapts API Gateway
events to the handlers, and `template.yaml` describes the stack:

- **Lambda** `jira-status-api` (Node 22, arm64) behind an **HTTP API** for `/api/*`.
- **S3** bucket with the page, private, read only by CloudFront.
- **CloudFront** serving both on one hostname: `/api/*` to the API (no caching), everything else
  from S3. One origin means no CORS and the Entra redirect URI is simply the CloudFront URL.
- **Secrets Manager** secret `jira-status/jira` with `{"email": ..., "token": ...}`, read once per
  cold start. The Entra ids are plain stack parameters.
- **CloudWatch Logs** group `/aws/lambda/jira-status-api`, 90-day retention. This is where the
  JSON request lines go.

Stack name and region live in `samconfig.toml` (`jira-status`, `us-east-1`).

### Prerequisites

AWS CLI v2, SAM CLI, Node 20+, and an AWS profile with rights to create the resources above
(CloudFormation, Lambda, API Gateway, S3, CloudFront, Secrets Manager, IAM roles, CloudWatch Logs).
With IAM Identity Center:

```
aws configure sso --profile jira-status     # start URL, region, account, permission set
aws sso login --profile jira-status
```

### Deploy

```
AWS_PROFILE=jira-status aws/deploy.sh
```

The script runs `sam build` and `sam deploy`, writes `JIRA_EMAIL`/`JIRA_API_TOKEN` from `.env.local`
into the secret, syncs `public/` to the bucket and invalidates CloudFront. It prints the site URL
at the end. Re-run it for every code or config change; nothing else is needed.

First deploy only: add the printed URL (with the trailing slash) as a **redirect URI** on the app
registration, otherwise Microsoft refuses the sign-in with AADSTS50011.

### Company hostname

DNS for profitsolv.com is in Cloudflare (IT), so this is a three-record exchange with IT:

1. Request a certificate in **us-east-1** (CloudFront only accepts certificates from that region):
   `aws acm request-certificate --domain-name jira-status.profitsolv.com --validation-method DNS --region us-east-1`
   then `aws acm describe-certificate` to read the validation CNAME (name starts with `_`).
2. Ask IT to add two CNAMEs in Cloudflare, both **DNS only** (grey cloud, not proxied):
   the validation record from step 1, and `jira-status.profitsolv.com` → the `CloudFrontDomain`
   stack output (`dxxxx.cloudfront.net`). Ask them to add `https://jira-status.profitsolv.com/` as
   a redirect URI on the app registration at the same time.
3. When the certificate shows `ISSUED`, set `SITE_DOMAIN` and `SITE_CERT_ARN` in `.env.local` and
   run `aws/deploy.sh` again. The distribution gets the alias and certificate, and `SiteUrl` flips to
   the company name. The CloudFront URL keeps working as well.

### Differences from Vercel

- Request bodies: API Gateway allows 10 MB and Lambda responses 6 MB, so the 4 MB attachment cap
  still fits (bodies arrive base64-encoded, about a third larger).
- `vercel.json` is ignored on AWS; `template.yaml` plays that role.
- Logs: `aws logs tail /aws/lambda/jira-status-api --follow --profile jira-status`. From Git Bash
  prefix the command with `MSYS_NO_PATHCONV=1`, or the `/aws/...` name is rewritten as a Windows path.
- Tear down: `sam delete --profile jira-status` (empty the site bucket first).

## Changing config

Edit the JSON files and redeploy (push to the connected branch):

- Add or remove an email domain → `config/allowed-domains.json`
- Add or remove a project → `config/projects.json` (the integration user also needs Browse on it)
- Change the Salesforce field, sprint field, or max results per case → `config/settings.json`
- Change upload size, file count, allowed extensions, or the attribution comment → `config/uploads.json`
- Change comment length or the author header → `config/comments.json`
- Change which statuses allow a reopen request, the label, or reason length → `config/reopen.json`

## Local development

```bash
cd jira-status
npm install
cp .env.example .env.local   # fill in real values
npx vercel dev               # http://localhost:3000
```

`node --check api/lookup.js` does a quick syntax check without running anything.

## Security notes

- The API token never reaches the browser; only the serverless function holds it.
- Without Microsoft sign-in, the typed email is a domain gate, not authentication: anyone with the
  URL and a company-looking address can use the page. Set `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`
  (see "Microsoft sign-in") to require a verified work account.
- Not-found responses are deliberately generic so the page does not reveal which other projects
  exist or which keys are restricted.
- Jira Cloud treats a bad or expired API token as an anonymous caller and answers 404 rather than
  401. The function therefore verifies the credentials against `/rest/api/3/myself` once every
  10 minutes per instance and checks the `X-Seraph-Loginreason` header on every response. A bad
  token produces "Server is not configured." (HTTP 500) and an `error` line in the log, never a
  false "Not found".
