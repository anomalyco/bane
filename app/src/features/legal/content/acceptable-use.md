---
title: Acceptable Use Policy
description: What you may and may not do with Nightmail, the published sending limits and enforcement thresholds, and how to report abuse.
updated: 13 November 2026
effective: 13 November 2026
---

Nightmail shares sending infrastructure and reputation among its customers, so one sender's spam hurts everyone's delivery. This policy says what you may and may not do with Nightmail. It's part of the [Terms of Service](/legal/terms), and it applies to you, everyone in your workspaces, and every Agent (API key, MCP client, AI agent, inbox key or app password) that acts for you.

This policy isn't legal advice. You're responsible for knowing and following the laws that apply to your mail.

## 1. Send only mail people asked for

- **Get permission first.** Send marketing only to people who opted in to hear from you, or where the law clearly allows it without opt-in. Keep a record of when and how each person agreed.
- **No bought, rented, shared, scraped or appended lists.** Don't use lists from list brokers, lead sellers, co-registration you can't trace, or addresses harvested from websites, directories or other services.
- **No address guessing.** Don't send to guessed or generated addresses, or use Nightmail to check whether addresses exist.
- **Label mail honestly.** Mark marketing as marketing. Don't send promotions as "transactional" mail to avoid marketing rules, limits or screening.
- **Keep lists clean.** Remove addresses that bounce or complain. Nightmail suppresses hard bounces and complaints; don't try to get around that.
- **Watch your rates.** Keep complaints under 0.05% and hard bounces under 2%. Above that, Nightmail starts warning you ([section 9](#how-we-enforce-this-policy)).

## 2. Unsubscribes

- Every marketing message must have a clear, working way to unsubscribe. Nightmail adds an unsubscribe link and one-click unsubscribe headers (`List-Unsubscribe` and `List-Unsubscribe-Post`) to every marketing message it sends.
- Honor an unsubscribe as soon as possible, and always within **10 business days** (the CAN-SPAM and CASL limit).
- Don't ask for more than an email address to unsubscribe, don't charge for it, and don't re-add someone who unsubscribed unless they opt in again.

## 3. The law, in brief

These are short summaries, not the full rules.

| Law | Main points |
| --- | --- |
| **CAN-SPAM (US)** | Accurate From and routing information; no misleading subject lines; identify ads as ads; include a valid postal address; give an opt-out and honor it within 10 business days; you're responsible for anyone who sends for you. |
| **CASL (Canada)** | Express or implied consent before sending commercial messages; identify yourself and give contact details; a working unsubscribe for at least 60 days, processed within 10 business days; keep proof of consent. |
| **GDPR, ePrivacy and UK PECR (EU and UK)** | Marketing email to individuals generally needs prior consent (a narrow "soft opt-in" exists for existing customers); you need a lawful basis for all personal data; tell people how you use their data; tracking pixels and click tracking may need consent. |
| **Other laws** | Follow the anti-spam and privacy laws of every country you send to, such as Australia's Spam Act. |

**Tracking.** Today, Nightmail turns open and click tracking on by default for marketing mail and campaigns, and off for transactional mail and replies. You can turn tracking off for any message or campaign. If the law where your recipients live requires consent for tracking, get it or turn tracking off.

## 4. Honest messages and headers

- Use accurate From, Reply-To and sender names. Don't impersonate another person, brand or organization.
- Send only from domains you control, authenticated with DKIM and SPF. Hosted bulk sending also requires DMARC.
- Don't forge or hide headers, routing information or the origin of a message.
- Don't use misleading subject lines or preview text.

## 5. Prohibited content and uses

Don't use Nightmail to send, receive, store or link to:

- **Malware**, viruses, or links to them.
- **Phishing**, credential harvesting, or fake login, payment or account-recovery pages.
- **Fraud and scams:** advance-fee fraud, fake invoices, fake prizes, investment or crypto schemes, pyramid schemes, or impersonation of a bank, government or company.
- **Child sexual abuse material**, or any content that sexualizes minors. We report it to the authorities as the law requires.
- Non-consensual intimate images, or content that harasses, threatens, doxxes or incites violence or hatred against people.
- Illegal goods or services, or anything that breaks the law where it's sent or received.
- Content that infringes someone's intellectual property or privacy.

**Restricted categories.** These need our written approval before you send them, and we may refuse: adult content, online gambling, cannabis and other drugs, weapons, payday loans and debt collection, "get rich quick" offers, crypto promotions, affiliate and lead-generation mailings, and sending on behalf of third parties as a reseller or agency. Ask at [support@bane.mx](mailto:support@bane.mx).

## 6. No working around limits or screening

Don't:

- create extra workspaces or accounts to multiply sending limits or the free tier;
- split mail across workspaces, domains or senders ("snowshoeing") to stay under thresholds;
- move to a new domain or workspace to escape a warning, hold or pause;
- hide text from the spam screen: invisible or tiny text, zero-width characters, mixed scripts, text only in images, or link shorteners and redirects that hide where a link goes;
- send test spam to probe the screen, or try to learn how detection works;
- misreport your mail's kind, volume or purpose when you ask for higher limits;
- use the API, SMTP or IMAP faster than the published rate limits, or in ways that harm other customers.

## 7. Receiving, inboxes and forwarding

- **Your addresses only.** Receive mail only for domains and addresses you control.
- **No bulk sign-ups elsewhere.** Don't use Nightmail inboxes (including short-lived agent inboxes and catch-all addresses) to mass-create accounts on other services, collect verification codes or free trials at scale, or get around another service's limits or terms.
- **No mail bombing.** Don't sign other people up to lists, or use your addresses to flood someone else.
- **Forwarding.** Forward only to people who agreed. A new outside forwarding address must confirm by email first. Don't create forwarding loops.
- **Storage.** Don't use Nightmail to store files or data unrelated to email.
- **IMAP and SMTP fair use.** Normal mail-client use is free. Downloads above 5 GB a day or 30 GB a month per inbox are slowed down. SMTP submission follows the same sending rules and limits as the API.
- **Other people's mail.** Don't read or keep someone else's mail through Nightmail without the right to do so, for example by pointing a domain you don't own at Nightmail.

## 8. AI agents, MCP and Omens

- **You're responsible for your agents.** An AI agent using your credentials is you. Give agents the narrowest keys that work, and watch what they send.
- **Omens give scores, not facts.** They can be wrong. Don't use an Omen alone to make decisions with legal or similarly significant effects on a person, such as refusing a service, a job or credit.
- **No sensitive guesses.** Don't ask Omens to infer a person's health, sexuality, religion, political views, ethnicity, union membership or other sensitive traits.
- **No attacks on the classifier.** Don't try to extract, copy or reverse-engineer the classifier or its instructions, use its outputs to train a competing model, or plant instructions in mail to manipulate it.
- **No secrets in questions.** Omen questions are sent to the classifier. Don't put passwords, keys or personal data in them.

## 9. How we enforce this policy

Most problems are handled by Nightmail's automatic sender score. It moves through steps, from least to most serious:

1. **Notice.** A note on your score card, for a first complaint or a few bounces. Nothing changes.
2. **Warn.** We email owners and admins. Your daily limit stops growing. It clears by itself after a day of good sending.
3. **Restrict.** We hold your **marketing** mail and pause campaigns. Transactional mail (receipts, password resets) keeps flowing. You can resume from the dashboard after fixing the cause, at a reduced rate at first.
4. **Pause.** **All sending stops.** Your inboxes, receiving and dashboard keep working. Queued mail waits 72 hours, then is canceled. Some pauses you can lift yourself; others need our review.

The [thresholds below](#sending-limits-and-thresholds) say exactly when each step happens. Each pause leaves a strike for 90 days, and repeated pauses make recovery slower.

**Serious abuse skips the ladder.** For phishing, malware, fraud, illegal content, or when Amazon pauses your sending, we may pause or close the account at once, cancel queued mail, suppress addresses, keep evidence, and report to the authorities where the law requires.

**Appeals.** Use "Ask for review" or "Contact support" in the dashboard, or email [support@bane.mx](mailto:support@bane.mx). A person reviews every appeal.

## 10. Sending limits and thresholds

These are the current limits and thresholds for Hosted sending. We may change them; lowering a limit applies to new mail, never to mail already accepted.

### Score and daily limit

| Sender score | Daily limit (rolling 24 hours, recipients) | Per minute | Marketing per hour |
| --- | --- | --- | --- |
| New workspace, first 100 recipients | 100 | 50 | 25 |
| Under 65 | 100 | 50 | 25 |
| 65–69 | 200 | 50 | 50 |
| 70–74 | 500 | 50 | 125 |
| 75–79 | 1,000 | 50 | 250 |
| 80–84 | 2,000 | 100 | 500 |
| 85–89 | 5,000 | 250 | 1,250 |
| 90 and up | 10,000 | 500 | 2,500 |
| On request | 25,000, 50,000 or 100,000 | Up to 1,000 | A quarter of the daily limit |

- A new workspace sends up to 100 a day until 100 real recipients have been accepted and 24 hours have passed. Its score then starts at 65 if the mail was good, lower if it wasn't.
- The score moves towards its target by at most +5 a day and −10 a day.
- Marketing can use the daily limit except a reserve for transactional mail: the larger of 100 or 10% of the limit.

### What the score is made of

| Factor | Weight | Best (100) | Worst (0) |
| --- | --- | --- | --- |
| Complaints ÷ delivered | 30 | 0.01% or less | 0.3% or more |
| Spam-screen rejections ÷ screened | 20 | 0.1% or less | 3% or more |
| Hard bounces to known recipients ÷ accepted | 15 | 0.5% or less | 5% or more |
| List quality: first-send bounces and suppression hits | 15 | 2% or less | 10% or more |
| Authentication: DKIM, aligned SPF and enforcing DMARC | 10 | All three | None |
| Marketing unsubscribes ÷ delivered, lifted by clicks | 10 | 0.2% or less | 2% or more |

Evidence fades with a 30-day half-life. Opens are ignored, because mail privacy features inflate them.

### When each step happens

Nightmail checks every 10 minutes. Each line needs a count and a rate together.

| Signal | Warn | Restrict | Pause |
| --- | --- | --- | --- |
| Complaints | 0.05% and at least 2 in 24 hours, or 0.05% and at least 3 in 7 days | 0.1% and at least 3 in 24 hours | 0.3% and at least 5 in 24 hours, or 0.15% and at least 10 in 7 days |
| Hard bounces | 2% and at least 10 in 24 hours, or 1.5% and at least 10 in 7 days | Marketing 4% and at least 25, or any mail 8% and at least 50, in 24 hours | Transactional mail 5% and at least 50 in 24 hours |
| Spam-screen rejections ÷ screened | 2% and at least 3 in 24 hours | 5% and at least 10 in 24 hours | 10% and at least 25 in 24 hours |
| External | – | – | Amazon paused the workspace's sending, or confirmed abuse |

### Campaign list check

A Hosted campaign with more than 100 recipients first sends to a sample: 10% of its recipients, at least 100 and at most 500. If more than 3% of the sample hard-bounces, or 2 recipients complain, the campaign pauses for review and the bounced addresses are suppressed. A campaign also pauses at more than 2% bounces after 1,000 accepted, or more than 0.08% complaints after 2,000. A paused campaign never pauses the whole account.

## 11. Reporting abuse

Report spam, phishing or other abuse sent through Nightmail to [abuse@bane.mx](mailto:abuse@bane.mx). Include the full message headers. We'll investigate and act.

## 12. Changes

We may update this policy. We'll give notice of material changes as described in the [Terms of Service](/legal/terms#changes-to-these-terms).
