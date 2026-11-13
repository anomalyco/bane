---
title: Privacy Policy
description: How Anomaly handles personal data in Nightmail: what we collect about customers, how we process the mail customers send and receive, screening and AI, retention, and your rights.
updated: 13 November 2026
effective: 13 November 2026
---

This policy explains how **Anomaly Innovations, Inc.** ("Anomaly", "we", "us") handles personal data in **Nightmail**, the email service at bane.mx: its website, API, dashboard, SDK, MCP server, and IMAP and SMTP access.

## 1. Two roles: controller and processor

Nightmail handles personal data in two different roles.

| Data | Whose decision | Our role |
| --- | --- | --- |
| **About our customers:** people who sign in, workspace members, billing contacts, people who contact support or report abuse | Ours | **Controller.** This policy applies in full. |
| **In our customers' mail:** the people our customers email, the people who email them, contacts and lists, and message content | The customer's | **Processor** (a "service provider" under US state privacy laws). The customer's own privacy policy applies. We process this data on the customer's instructions, under our [Terms of Service](/legal/terms) and, where one is signed, our Data Processing Addendum. |
| **Customer mail we screen to prevent abuse and to compute sender scores** | Ours, for this purpose only | **Controller**, only to keep the service safe for recipients and customers ([section 5](#automated-screening-and-ai)). We don't use it for anything else. |

**If you got an email sent through Nightmail, or sent mail to an address that uses Nightmail,** the business that uses Nightmail decides what happens to your data. Contact them first. If you contact us, we'll pass your request to them where we can identify them ([section 12](#rights-of-people-in-our-customers-mail)).

## 2. Data about our customers

| What | Details | Source |
| --- | --- | --- |
| **Identity** | Name, email address, and the account identifier from Anomaly's sign-in service (account.anoma.ly). For Google sign-ins: Google's account ID, whether the email is verified, and the Google Workspace domain if there is one. | You, through the sign-in service and Google |
| **Workspaces** | Workspaces you belong to, your role (owner, admin or member), and invitations (email address and role) | You and other members |
| **Credentials** | API keys, MCP grants, agent tokens, inbox keys and app passwords. Keys are stored as hashes; we can't read them back. | You |
| **Sessions** | A session cookie, valid for up to 7 days. Sessions don't record your IP address or browser. | Your browser |
| **Sign-in attempts** | Issuer, account ID, sign-in method and provider, email and name, outcome and time. Kept 30 days; refused sign-in requests 90 days. | Sign-in service |
| **Activity (audit trail)** | Who did what in a workspace (for example, created a key or changed a role), when, the reason, the request ID, your network (shortened to the first three parts of an IPv4 address, or a /48 for IPv6) and browser family. Never secrets or message content. | Our systems |
| **Billing** | Stripe customer ID; card brand, last four digits, expiry and fingerprint; top-ups, refunds, disputes, balance and usage history. **Stripe holds your full card number; we never see it.** | You and Stripe |
| **Usage** | How much each workspace sends, receives and stores, and its sender score and standing | Our systems |
| **Support** | Your support request: the page you were on, recent request IDs, your message, and whether you allowed support to read message content | You |
| **Notices** | Emails we send you about billing, limits, standing and these policies | Our systems |
| **Technical logs** | Request logs (method, path, status, timing and error codes), and connection logs from the IMAP and SMTP gateway, which may include the connecting IP address. Request logs are kept about 3 days; gateway logs 30 days. | Our systems |

**Cookies.** Nightmail uses a session cookie (up to 7 days) and a short-lived sign-in cookie (10 minutes). The Nightmail website and dashboard use **no analytics or advertising cookies**.

## 3. Data in our customers' mail

### 3.1 Sending

- Recipient, Cc and Bcc addresses; From, Reply-To and sender name; subject; HTML and text content; attachments; custom headers.
- Delivery events: sent, delivered, bounced (with the reason), complained, rejected and delayed. If tracking is on, opened and clicked, with the link clicked and whether the event looked like it came from a bot. Today, tracking is on by default for marketing mail and campaigns, and off for transactional mail and replies; customers can turn it off for any message or campaign.
- Contacts, lists and segments the customer uploads, with consent, unsubscribe and suppression records, and the last time each contact opened or clicked.
- Campaign drafts and templates.

### 3.2 Receiving

- The sender, recipients, subject, headers, text and HTML bodies, and attachments of mail sent to a customer's addresses.
- Authentication results (SPF, DKIM and DMARC) and Amazon's spam and virus verdicts.
- What the customer's routing and rituals did with each message: delivered, labeled, junked, forwarded, posted to Slack or Discord, or sent to a webhook.
- Omen questions and the scores returned.
- For inboxes: folders, read state and flags.

### 3.3 What customers send elsewhere

Customers can send their data to places they choose: their webhooks, Slack or Discord, forwarding addresses, MCP clients and AI agents, mail clients over IMAP, and their own AWS account. Those are the customer's choices and aren't our subprocessors.

## 4. Why we use data, and our legal bases

| Purpose | Data | Legal basis (EU and UK) |
| --- | --- | --- |
| Provide the service: sign you in, run workspaces, send and receive mail as customers instruct | Account data; customer mail as processor | Contract |
| Billing: take payments, keep the balance, send receipts and notices, handle refunds and disputes | Billing and usage data | Contract; legal obligation (tax and accounting records) |
| Security, fraud and abuse prevention: spam screening, sender scores and limits, card-fraud checks, investigating abuse reports | Usage data; screening results; message metadata and content as screened ([section 5](#automated-screening-and-ai)) | Legitimate interests (protecting recipients, customers and our infrastructure) |
| Support | Account data; message content only with your permission | Contract; consent for message content |
| Service and policy notices | Contact details | Contract; legitimate interests |
| Improve the service and publish aggregate statistics (for example, total mail volume on our homepage) | Aggregated usage | Legitimate interests. Aggregates don't identify anyone. |
| Comply with the law and respond to valid legal requests | As needed | Legal obligation |

We **don't sell** personal data, don't "share" it for cross-context behavioral advertising, and don't use it for advertising.

## 5. Automated screening and AI

### 5.1 What is screened

| What | When | What the classifier receives |
| --- | --- | --- |
| **Spam screen on sending** | Messages sent through Nightmail's shared (Hosted) sending pool, before they reach Amazon. Repeated identical content may reuse a recent result. | The sender name and address, subject, visible text from the HTML and text parts, and the domains of links, up to about 24 KB per message |
| **Forwarded mail** | When a ritual forwards a received message to an outside address | The same parts of the forwarded message |
| **Omens** | Only for receiving domains or routes the customer opted in | The subject, sender, authentication results and up to 8,000 characters of visible text, plus the customer's questions |

Received mail isn't sent to the classifier unless the customer turns on Omens or a forward. BYO AWS sending isn't screened unless the customer asks for it.

### 5.2 Who runs it

The classifier is **Jev**, from **TypeSafe AI**. Nightmail calls TypeSafe's API directly.

### 5.3 What the results are used for

- A message whose spam score is over the threshold is **rejected before it's sent**. The rejection is recorded with the score and model name.
- Rejection rates feed the workspace's **sender score**, which sets its daily sending limit and can lead to a warning, a hold on marketing, or a pause.
- Omen scores are given to the customer's rituals, which decide what to do.

### 5.4 People and automated decisions

- Anomaly staff who review abuse see a workspace's score history, bounce and complaint counts by recipient domain, and, for the last 7 days, the **subject line (first 120 characters) and score** of each rejected message. They don't see message bodies.
- A workspace can ask for a person to review any warning, hold or pause (see the [Terms of Service](/legal/terms#getting-back-and-appeals)).
- These decisions concern a customer's sending account, not the people in the customer's mail.

### 5.5 Training

- **Anomaly doesn't use customer mail or Omen questions to train AI models.**
- **TypeSafe has confirmed to us in writing that it doesn't retain or train on** the content Nightmail sends to it.

## 6. Support access

- Support can't browse your workspace. A support person gets access only for a specific request, after we've confirmed who you are (through the dashboard, or a verified email).
- Access is **read-only**, expires within **2 hours**, and is limited to the workspaces you belong to.
- **Message content only with your permission.** When you use "Contact support" in the dashboard, a checkbox (off by default) lets support read message content for that one request, in that one workspace. A request by email never includes message content.
- Without your permission, support sees settings, domains, delivery events, error codes, webhook delivery status (not payloads or URLs), standing, billing and your workspace's activity trail. Never keys, passwords or webhook secrets.
- Your workspace's **Activity** page shows "Nightmail support viewed this workspace" with the request. Every support read is logged and kept 90 days.
- Any other access to systems that hold message content is limited to Anomaly personnel who need it to run, secure or repair Nightmail.

## 7. Subprocessors and other recipients

The providers that process personal data for Nightmail, what each does and where, are listed on the [Subprocessors](/legal/subprocessors) page. We update that page before a new subprocessor starts processing personal data.

We also disclose data when the law requires it, to protect people or the service, or to a buyer or successor in a merger or sale, under this policy.

## 8. International transfers

Nightmail stores and processes data mainly in the **United States**. Cloudflare may process requests in data centers close to the user anywhere in the world. When we transfer personal data from the EU, the UK or Switzerland, we rely on the European Commission's Standard Contractual Clauses (with the UK Addendum for UK data) or another transfer mechanism the law allows. There's no EU data-residency option today.

## 9. How long we keep data

| Data | How long |
| --- | --- |
| **Received mail** (text, HTML, headers, attachments) to ordinary addresses | **Kept until the customer deletes it** (no automatic expiry). To delete received mail for ordinary addresses, a workspace owner emails [support@bane.mx](mailto:support@bane.mx). Mail older than 90 days counts as billable storage. |
| Raw original message (MIME) for ordinary addresses | 90 days |
| **Persistent inbox** mail | Until deleted |
| **Agent inbox** mail | Erased when the inbox ends: by default after 24 hours plus 24 hours of grace (at most 30 days plus 7); a 45-day safety rule backs this up |
| Incoming mail awaiting processing | 3 days |
| Mail that couldn't be matched to a customer (quarantine) | 30 days |
| Mail held because a balance is unpaid | Until the customer adds credit or the workspace is closed |
| **Sent mail** records (content, recipients) and delivery events | 30 days |
| Received-mail events and webhook delivery records | 30 days |
| Contacts, lists, consent and suppression records | Until the customer deletes them. Unsubscribe and suppression records may be kept after a contact is deleted so the opt-out keeps working. |
| Routing and ritual version history | Up to 1 year |
| Audit trail | 1 year; billing and payment events 7 years; support reads 90 days |
| Billing ledger and payment records | 7 years, including after a workspace is closed |
| Stripe webhook events | 90 days |
| Sign-in attempts | 30 days; refused sign-in requests 90 days |
| Sessions | Until they expire (up to 7 days) |
| Request logs | About 3 days; IMAP and SMTP gateway logs 30 days |
| Database backups | Until they expire on our database provider's backup schedule. Deleting data doesn't remove it from backups before then. |

When a workspace is closed, we delete its data as described in the [Terms of Service](/legal/terms#ending-the-agreement).

## 10. Security

- Data is encrypted in transit with TLS. IMAP and SMTP require TLS before you sign in: implicit TLS on ports 993 and 465, or STARTTLS on ports 143 and 587.
- Stored data is encrypted at rest by our infrastructure providers (Amazon S3, Cloudflare R2 and PlanetScale).
- Webhook secrets and endpoint URLs are encrypted in the database. API keys and support tokens are stored as hashes.
- Customers' data is separated by workspace in every database query and storage path.
- The audit trail can't be changed or deleted before its retention ends, even by administrators.
- Support access is short-lived, read-only, limited to one customer, and logged.

We'll notify affected customers and authorities of a personal data breach as the law requires.

## 11. Your rights

Depending on where you live, you may have the right to access, correct, delete or export your personal data, to object to or restrict some uses, to withdraw consent, and to complain to a data-protection authority. US state residents may also have the right to know, delete and correct, and not to be discriminated against for using these rights. We don't sell or share personal data for advertising.

To use these rights, email [privacy@bane.mx](mailto:privacy@bane.mx). We'll verify who you are and answer within the time the law requires (usually 30 or 45 days).

**Data Processing Addendum.** Business customers who need one can request our Data Processing Addendum at [privacy@bane.mx](mailto:privacy@bane.mx).

## 12. Rights of people in our customers' mail

If you received mail sent through Nightmail, or sent mail to an address hosted on Nightmail:

- **To unsubscribe,** use the link in the email. It works without contacting us.
- **To access or delete your data,** contact the business that sent you the mail or owns the address you wrote to. They control your data.
- **If you contact us** at [privacy@bane.mx](mailto:privacy@bane.mx), we'll forward your request to that business where we can identify it, and help them respond as our contracts require.
- **To report spam or abuse,** email [abuse@bane.mx](mailto:abuse@bane.mx) with the full headers.

## 13. Children

Nightmail is a business service and isn't for children. You must be at least **18** to create an account. We don't knowingly collect personal data from children; if we learn we have, we'll delete it.

## 14. Changes

We'll post updates on this page and tell customers by email or in the dashboard at least 30 days before material changes take effect.

## 15. Contact

Anomaly Innovations, Inc.\
2443 Fillmore St #380-6343, San Francisco, CA 94115, United States

Privacy and data requests: [privacy@bane.mx](mailto:privacy@bane.mx)
