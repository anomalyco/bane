/**
 * How to check that a webhook delivery came from Bane, in words and as code. Shared by the dashboard's Docs guide
 * (#guide-webhook-signatures) and the API's /docs.md and /llms.txt, so it has no runtime imports and ships to browsers.
 */
export const webhookSignatureGuide = {
  id: 'webhook-signatures',
  title: 'Verify webhook signatures',
  summary: 'Check that a delivery came from Bane: the signature headers, the signing secret and a Node example.',
  text: 'Every webhook delivery (email events and inbound webhooks alike) carries Webhook-Id, Webhook-Timestamp (Unix seconds) and Webhook-Signature headers in the Standard Webhooks format. Compute HMAC-SHA256 over "{Webhook-Id}.{Webhook-Timestamp}.{raw body}" with the base64-decoded part of the signing secret after whsec_, and compare it in constant time to the value after v1, in Webhook-Signature. Reject timestamps more than five minutes old, and use Webhook-Id to skip a delivery you already handled. Standard Webhooks libraries (such as the standardwebhooks npm package) verify it too. The secret is shown once when you create a webhook; reveal or rotate it on the webhook’s page, or with revealWebhookSecret (from an API key you made) and rotateWebhookSecret. MCP approvals can rotate it but not read it back; temporary agent tokens can do neither. Every reveal and rotation is recorded.',
  language: 'js',
  code: `import { createHmac, timingSafeEqual } from 'node:crypto'

// secret: the webhook's signing secret (whsec_…). body: the raw request body, before JSON.parse.
export function verifyBaneWebhook(secret, headers, body) {
  const id = headers['webhook-id'], timestamp = headers['webhook-timestamp']
  if (!id || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const expected = createHmac('sha256', key).update(\`\${id}.\${timestamp}.\${body}\`).digest()
  return String(headers['webhook-signature'] ?? '').split(' ').some(part => {
    const [version, signature = ''] = part.split(',')
    const given = Buffer.from(signature, 'base64')
    return version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected)
  })
}`,
};
