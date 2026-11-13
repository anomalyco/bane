---
title: Subprocessors
description: The providers that process personal data for Nightmail, what each one does, and where.
updated: 13 November 2026
effective: 13 November 2026
---

These providers process personal data for Nightmail on behalf of **Anomaly Innovations, Inc.** ("Anomaly"), as described in our [Privacy Policy](/legal/privacy).

## Current subprocessors

| Provider | What it does for Nightmail | Data | Where |
| --- | --- | --- | --- |
| **Amazon Web Services** | Sends and receives mail (Amazon SES); stores incoming mail briefly before processing, quarantined mail and mail held for unpaid balances (S3); delivery events (SNS and SQS); runs the IMAP and SMTP gateway (ECS); gateway logs; secrets | All mail content and metadata | United States: Ohio (us-east-2) and Northern Virginia (us-east-1) |
| **Cloudflare** | Runs the API, website and dashboard (Workers, Durable Objects and Queues); stores received mail and attachments (R2); connects to the database (Hyperdrive); renders campaign previews (Browser Rendering); request logs; DNS and edge network; DNS lookups about customer domains | All | Received-mail storage: Eastern North America. Request processing: Cloudflare's global network. |
| **PlanetScale** | Main database (Postgres): accounts, workspaces, logs, contacts, received message text and billing | All | United States: AWS Ohio (us-east-2) |
| **Stripe** | Card payments, receipts, saved cards and fraud checks (Radar) | Billing contact and payment data | United States |
| **TypeSafe AI** | Jev classifier: the spam screen and Omens. Doesn't retain or train on the content. | Parts of message content ([Privacy Policy, section 5.1](/legal/privacy#what-is-screened)) | United States |

## Other recipients

- **Anomaly account (account.anoma.ly)** is Anomaly's own sign-in service. It shares your name, email address, account identifiers and sign-in method with Nightmail.
- **Google** is a sign-in provider behind your Anomaly account; Google's own privacy policy applies to your Google account.
- **Domain tools.** Nightmail looks up public DNS records (through Cloudflare's resolver) and domain registration data (RDAP) for customer domains. If you use one-click DNS setup (Domain Connect), you're sent to your DNS provider.
- **Services customers connect.** Webhooks, Slack and Discord endpoints, forwarding addresses, MCP clients, mail clients and a customer's own AWS account receive data because the customer chose them. They aren't our subprocessors.

## Changes

We update this page before a new subprocessor starts processing personal data. Business customers with a signed Data Processing Addendum get notice of changes as that addendum describes. Questions: [privacy@bane.mx](mailto:privacy@bane.mx).
