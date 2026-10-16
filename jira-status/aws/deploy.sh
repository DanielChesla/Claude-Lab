#!/usr/bin/env bash
# Build + deploy the SAM stack, store the Jira credentials in Secrets Manager, upload the page and
# invalidate CloudFront. Reads .env.local if present (JIRA_EMAIL, JIRA_API_TOKEN, ENTRA_*, SITE_DOMAIN, SITE_CERT_ARN).
# Usage: AWS_PROFILE=jira-status aws/deploy.sh      (stack name and region come from samconfig.toml)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
STACK=$(sed -n 's/^stack_name = "\(.*\)"/\1/p' samconfig.toml)
REGION=$(sed -n 's/^region = "\(.*\)"/\1/p' samconfig.toml)
# Git Bash on Windows: the SAM CLI ships only a sam.cmd shim, which cmd.exe mangles when arguments
# contain quotes. Call its bundled Python directly instead.
if ! command -v sam >/dev/null 2>&1 && command -v sam.cmd >/dev/null 2>&1; then
  SAM_PY="$(dirname "$(command -v sam.cmd)")/../runtime/python.exe"
  sam() { "$SAM_PY" -m samcli "$@"; }
fi

sam build

# Only attach the custom hostname once its certificate is issued; CloudFront rejects pending ones.
if [ -n "${SITE_CERT_ARN:-}" ]; then
  CERT_STATUS=$(aws acm describe-certificate --certificate-arn "$SITE_CERT_ARN" --region us-east-1 --query Certificate.Status --output text 2>/dev/null || echo UNKNOWN)
  if [ "$CERT_STATUS" != "ISSUED" ]; then echo "Certificate is $CERT_STATUS, deploying without the custom hostname for now."; SITE_DOMAIN=""; SITE_CERT_ARN=""; fi
fi
sam deploy --parameter-overrides "EntraTenantId=${ENTRA_TENANT_ID:-} EntraClientId=${ENTRA_CLIENT_ID:-} DomainName=${SITE_DOMAIN:-} CertificateArn=${SITE_CERT_ARN:-}"

out() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out SiteBucketName); DIST=$(out DistributionId); SECRET=$(out JiraSecretArn); URL=$(out SiteUrl)

if [ -n "${JIRA_EMAIL:-}" ] && [ -n "${JIRA_API_TOKEN:-}" ]; then
  SECRET_JSON=$(node -e 'console.log(JSON.stringify({ email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN }))')
  aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" --secret-string "$SECRET_JSON" >/dev/null
  echo "Jira secret updated."
else
  echo "JIRA_EMAIL / JIRA_API_TOKEN not in the environment; secret left as is."
fi

aws s3 sync public/ "s3://$BUCKET/" --delete --cache-control "no-cache" --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --region "$REGION" >/dev/null
echo "Deployed: $URL"
