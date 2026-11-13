---
title: Terms of Service
description: The agreement between you and Anomaly for using Nightmail: accounts, prepaid billing, refunds and credit expiry, sending limits, your data, and how disputes are resolved.
updated: 13 November 2026
effective: 13 November 2026
---

These Terms of Service (the "Terms") are a binding agreement between you and **Anomaly Innovations, Inc.** ("Anomaly", "we", "us"). They cover Nightmail: the hosted email service at bane.mx, its API, dashboard, SDK, MCP server, and IMAP and SMTP access (together, the "Service").

By creating an account, joining a workspace or using the Service, you accept these Terms, the [Acceptable Use Policy](/legal/acceptable-use) and the [Privacy Policy](/legal/privacy). If you use the Service for an organization, you accept these Terms on its behalf and confirm that you're authorized to do so. "You" then means that organization.

> **ARBITRATION NOTICE AND CLASS ACTION WAIVER:** EXCEPT FOR CERTAIN TYPES OF DISPUTES DESCRIBED IN THE [ARBITRATION AGREEMENT](#arbitration-agreement), YOU AGREE THAT DISPUTES BETWEEN YOU AND US WILL BE RESOLVED BY BINDING, INDIVIDUAL ARBITRATION AND YOU WAIVE YOUR RIGHT TO PARTICIPATE IN A CLASS ACTION LAWSUIT OR CLASS-WIDE ARBITRATION. You can opt out by mail within 30 days of first accepting these Terms ([section 20](#governing-law-and-disputes)).

## 1. Who can use Nightmail

- You must be at least **18** and able to form a binding contract.
- **Nightmail is for business use only.** You may use it only for your trade, business, craft or profession, and not as a consumer. By accepting these Terms you confirm that you're using Nightmail for business purposes.
- You can't use Nightmail if you're barred by sanctions or export laws, or if we closed an earlier account of yours for breaking these Terms.

## 2. Key words

| Term | Meaning |
| --- | --- |
| **Account** | Your personal sign-in to Nightmail. |
| **Workspace** | A shared space that holds domains, inboxes, contacts, keys, settings and its own **prepaid balance**. A person can belong to several workspaces. |
| **Owner, admin, member** | Workspace roles. Owners and admins manage billing, members and keys. |
| **Customer Data** | Everything you or your users put into Nightmail or receive through it: messages, attachments, contacts, lists, templates, rituals, settings and the data in them. |
| **Recipients and correspondents** | The people you email, and the people who email your addresses. |
| **Credit** | Money you add to a workspace's prepaid balance. |
| **Hosted** | Nightmail sends and receives mail through Anomaly's own Amazon SES accounts. |
| **BYO AWS** | Nightmail works with your own Amazon Web Services account; AWS bills you directly for it. |
| **Agent** | Any software that acts for you through an API key, MCP connection, agent token, inbox key or app password, including AI agents. |

## 3. Accounts and workspaces

- **Sign-in.** You sign in with an Anomaly account (account.anoma.ly). We may require a particular sign-in method, such as Google. Keep your sign-in secure. You're responsible for activity under your account.
- **Workspaces.** The person who creates a workspace is its first owner. Owners decide who joins and in which role, and can transfer ownership. Each workspace is billed on its own.
- **Credentials.** API keys, MCP grants, agent tokens, inbox keys and app passwords act for the workspace that issued them. Keep them secret and revoke any that leak. **You're responsible for everything your credentials and Agents do**, including mail an AI agent sends.
- **Accurate information.** Keep your contact and billing details current. We send notices about billing, sending limits and these Terms to workspace owners and admins.
- **Several workspaces.** You may create more than one workspace. You may not use extra workspaces or accounts to get more free usage or higher sending limits (see the [Acceptable Use Policy](/legal/acceptable-use#no-working-around-limits-or-screening)). Sending limits are shared between workspaces created by the same account.

## 4. The Service

- **What Nightmail does.** Transactional and marketing sending, receiving mail for your domains, inboxes (including short-lived agent inboxes), IMAP and SMTP access, webhooks, routing and **Rituals** (scripts that act on received mail), **Omens** (questions an AI classifier answers about a received message), sender reputation tools and an MCP server.
- **Your domains.** You may only send from, or receive for, domains and addresses you own or are authorized to use. You set up DNS records to prove it. If you lose control of a domain, we may stop sending and receiving for it.
- **Delivery isn't guaranteed.** We hand your mail to receiving servers. We can't control whether they accept it, file it as spam, or how fast they deliver it. Receiving depends on senders and their providers.
- **Changes.** We may add, change or remove features. If we remove a material paid feature, we'll give at least 30 days' notice. Beta or preview features are provided as they are and may change or end.
- **BYO AWS.** Your use of your own AWS account is also governed by your agreement with AWS, and you pay AWS for it. Fair use for BYO AWS is about 10 million emails a month; above that, we may contact you about a separate plan.

## 5. Prices and billing

### 5.1 Prepaid balance

- Nightmail is **prepaid**. Each workspace has its own balance in **US dollars**. Usage is taken from the balance about once an hour.
- You add credit with a card through Stripe. One top-up is **$20 to $10,000**, before tax. Credit is added only once Stripe confirms the payment. Stripe emails a receipt.
- **Credit expires 12 months after purchase** and isn't refundable except as described in [section 5.7](#refunds-and-credit-expiry).
- Prices exclude taxes. Where the law requires us to collect sales tax, VAT, GST or a similar tax, we add it to the charge. Otherwise, you're responsible for any taxes on your purchases.
- There is no subscription and no monthly fee.

### 5.2 Prices

| What | Price | How it's counted |
| --- | --- | --- |
| Email | **$0.20 per 1,000** | Sent: per recipient. Received: per message accepted for your domains. |
| Omens | **$0.10 per 1,000** evaluations | One evaluation is one classifier call about one message. One call answers every question a ritual asks about that message, up to ten. |
| Storage | **$0.25 per GB-month** | Received mail older than 90 days, above 1 GB per workspace, measured daily. |
| IMAP and SMTP access | Free | Fair use: downloads up to 5 GB a day and 30 GB a month per inbox; above that, downloads slow down. |
| BYO AWS | Free | Fair use: about 10 million emails a month. |

- **Not charged:** mail Nightmail suppresses or cancels before it goes out, and mail rejected before sending for reasons other than the spam screen.
- **Charged:** a message the spam screen rejects is charged as a send.
- **Free:** received mail that Amazon's spam scan flags as spam. Omens asked about it are still charged.
- **Storage starts later.** Storage charges start **90 days after we notify you** that they apply. Until then, stored mail is free.

### 5.3 Free tier

- Each workspace gets, every calendar month (UTC): **3,000 emails** (sent and received combined) and **1 GB** of storage for received mail older than 90 days.
- Unused free usage doesn't roll over and has no cash value.
- We may limit the free tier to one per person or organization, or change it, with notice.

### 5.4 Auto-recharge

- Owners and admins can turn on auto-recharge. You then authorize us to charge your saved card the chosen amount whenever the balance falls below the chosen level.
- Defaults: recharge **$25** when the balance falls below **$10**, at most **$500** per calendar month. You can change these (from $20 to $1,000 per recharge; a monthly cap from $20 to $10,000) or turn auto-recharge off at any time.
- If a recharge is declined or needs extra authentication, auto-recharge turns off and we email the owners once. We don't retry automatically.
- **Received mail costs money too.** Received mail is charged even if you didn't ask for it (except mail flagged as spam). A flood of mail to your addresses can trigger auto-recharge up to your monthly cap. Set a cap you're comfortable with.

### 5.5 When the balance runs out

If a workspace's balance and its free usage are used up:

1. **Sending stops.** The API returns `402 BALANCE_EXHAUSTED`, campaigns wait, and SMTP submission is deferred. Omens return their fallback answer without asking the classifier.
2. **Receiving continues for 7 days.** Mail is still accepted and charged, so the balance can go below $0. That amount is a debt you owe.
3. **After 7 days, new received mail is held.** It's stored but not delivered to your inboxes, webhooks or rituals until you add credit. Mail you already have stays available.
4. **Nothing is deleted** because the balance is empty.

We email owners and admins when the balance is low (by default, below $5), when sending pauses, before mail is held, and when it's held.

### 5.6 Promotional credit and free accounts

- We may give promotional credit. It's used before paid credit, has no cash value, **is never refunded**, and may expire as stated when given.
- We may make a workspace, or every workspace a person owns, free of charge for a period. Usage is still measured. We may end this with notice by email.
- Some customers pay by invoice under a separate agreement. That agreement wins where it differs from these Terms.

### 5.7 Refunds and credit expiry

**Refunds.**

- **Credit you've used is never refunded.**
- **Unused credit isn't refundable**, except:
  - **billing errors:** we refund a duplicate charge or an incorrect charge;
  - **if we close your account without cause:** we refund the remaining unexpired paid balance;
  - **where the law requires a refund.**
- Promotional credit is never refunded.
- Refunds go to the original payment method. Tax we collected on a refunded amount is refunded with it.

**Expiry.**

- **Prepaid credit expires 12 months after the date you bought it.** Each top-up, including each auto-recharge, expires on its own date. Its purchase date is on its Stripe receipt.
- **The oldest credit is used first.**
- Support can tell you the remaining amount and expiry date of each top-up at any time: email [support@bane.mx](mailto:support@bane.mx).
- Expired credit is removed from the balance and isn't refunded.
- Promotional credit expires as stated when we give it.

### 5.8 Billing errors and disputes

- Tell us about a billing error within **60 days** of the charge, at [support@bane.mx](mailto:support@bane.mx).
- Please contact us before you dispute a charge with your bank. If you dispute a top-up, we remove the disputed credit from the balance (which can go below $0), and we may block that card.

### 5.9 Price changes

- We may change prices with at least **30 days'** notice by email or in the dashboard. New prices apply to usage after the effective date. Credit stays in dollars, so a price change changes how much usage your credit buys.
- New storage charges need 90 days' notice ([section 5.2](#prices)).

## 6. Acceptable use

You must follow the [Acceptable Use Policy](/legal/acceptable-use). In short: send only to people who agreed to hear from you, honor unsubscribes, don't send or receive illegal or harmful content, and don't work around limits or screening.

**You're the sender.** You're responsible for your mail, your lists, your consent records and complying with email and privacy laws (such as CAN-SPAM, CASL, GDPR and ePrivacy) for mail sent through your workspace.

## 7. Automated screening and sender score

- **Automated content screening.** To prevent fraud and abuse, Nightmail scans the content of email sent through, or received into, your workspace with an automated classifier. This covers mail sent through Nightmail's shared (Hosted) sending pool, mail your rituals forward to outside addresses, and received mail only where you turn on Omens. We use the results only to (a) prevent fraud, spam and other abuse of the Service, which may include holding, rejecting or reviewing messages, and (b) compute your workspace's sender score. We don't sell scanned content or results and don't use them for advertising.
- **Sender score.** Your sender score (0–100) is calculated from your workspace's own activity: complaints, spam-screen rejections, bounces, list quality, domain authentication and unsubscribes. It sets your **daily sending limit** and can lead to warnings, a hold on marketing mail, or a pause, as described in [section 8](#sending-limits-enforcement-and-suspension) and in the [published thresholds](/legal/acceptable-use#sending-limits-and-thresholds).
- **Screening can be wrong.** A classifier can block a legitimate message or miss a bad one. If you think a decision is wrong, ask for a review ([section 8.4](#getting-back-and-appeals)).

## 8. Sending limits, enforcement and suspension

### 8.1 Limits

Hosted sending has daily and per-minute limits that grow as your sender score rises. A new workspace starts at **100 recipients a day**. The current limits and thresholds are published in the [Acceptable Use Policy](/legal/acceptable-use#sending-limits-and-thresholds). We may change them; lowering a limit applies to new mail, never to mail already accepted. Limits above 10,000 a day are available on request.

### 8.2 The enforcement ladder

Nightmail checks sending quality about every 10 minutes. Each step needs both a count and a rate, so a few events don't trip a small sender.

| Step | What happens | Your mail |
| --- | --- | --- |
| **Notice** | A note on your score card. | Unchanged. |
| **Warn** | A dashboard card and an email to owners and admins. Your limit stops rising. | Unchanged. |
| **Restrict** | A banner and an email. | **Marketing mail is held** and campaigns pause. Transactional mail keeps flowing. |
| **Pause** | A red banner and an email. | **All sending stops.** Receiving, inboxes and the dashboard keep working. Mail already queued is held for 72 hours, then canceled. |

A pause happens for high complaint or spam-screen rates, high bounce rates on transactional mail, confirmed abuse, or when Amazon pauses your workspace's sending. Otherwise, bounces alone only hold marketing.

### 8.3 Other reasons we may limit or suspend

We may limit, suspend or stop the Service for a workspace or account, in whole or in part, if:

- you break these Terms or the Acceptable Use Policy;
- it's needed to protect recipients, other customers, our sending reputation or infrastructure, or to stop fraud (including card fraud or chargebacks);
- Amazon or another provider requires it;
- the law or a valid legal order requires it.

We'll tell you why and what to do, unless the law or an active investigation prevents it. For serious abuse (such as phishing, malware or illegal content) we may act at once without warning, cancel queued mail, and close the account.

### 8.4 Getting back and appeals

- **Warn** clears by itself after 24 hours of good sending.
- **Restrict:** an owner can resume marketing from the dashboard after 24 hours, once every 14 days, at 50% of the previous allowance for 48 hours.
- **Pause caused by transactional bounces:** an owner can resume once every 30 days, at 50% of the previous limit for 48 hours.
- **Any other pause** needs our review.
- Each pause leaves a **strike** for 90 days. A second strike limits you to 50% for 7 days; a third means every resume needs our review.
- **Appeals:** use "Ask for review" or "Contact support" in the dashboard, or email [support@bane.mx](mailto:support@bane.mx). A person at Anomaly reviews every appeal. We aim to respond within one business day.

## 9. Your data

- **You own your Customer Data.** We claim no ownership of it.
- **What you allow us to do.** You give us a worldwide, non-exclusive license to host, copy, process, transmit and display Customer Data only as needed to provide, secure and support the Service, to prevent abuse, to bill you, and as the law requires.
- **What we don't do.** We don't sell Customer Data, don't use it for advertising, and **don't use it to train AI models**. This covers the content we send to our AI provider for screening and Omens too: our AI provider, TypeSafe AI, has confirmed to us in writing that it doesn't retain or train on that content.
- **Aggregated data.** We may use data about how the Service is used (volumes, delivery and bounce rates, performance) to run and improve it, and to publish aggregate statistics that don't identify you, your recipients or your content.
- **People at Anomaly.** Support can't read your message content unless you allow it for a specific support request ([section 10](#support-access)). Staff who review abuse see message metadata, such as recipient domains and the subject line of a message the screen rejected, but not message bodies. Any other access to systems that hold message content is limited to Anomaly personnel who need it to run, secure or repair the Service.
- **Personal data.** For personal data in Customer Data, you're the controller and we're your processor (a "service provider" under US state privacy laws), as described in the [Privacy Policy](/legal/privacy). A Data Processing Addendum is available to business customers on request at [privacy@bane.mx](mailto:privacy@bane.mx).
- **Your responsibilities.** You must have a lawful basis to send and receive the personal data you put into Nightmail, give the notices your recipients need, and not send us special-category data you don't need.

## 10. Support access

- When you choose **Contact support** in the dashboard, you can tick a box to let support read message content **for that one request**. It's off by default.
- Support then gets short-lived (at most 2 hours), read-only access tied to your request and the workspaces you belong to. Without your tick, support sees settings, delivery events and error codes, but no message bodies. A request made by email never includes message content.
- Your workspace's **Activity** page shows "Nightmail support viewed this workspace" with the request. Every support read is logged and kept for 90 days.

## 11. Third-party services you connect

Nightmail can send your data where you tell it to: webhooks, Slack and Discord endpoints, forwarding addresses, MCP clients and AI agents, IMAP and SMTP mail clients, and your own AWS account. You choose those services, and we aren't responsible for what they do with the data. Forwarding to an outside address requires that address to confirm first.

## 12. AI features

- Omens and the spam screen use **Jev**, a classifier from TypeSafe AI. TypeSafe has confirmed to us in writing that it doesn't retain or train on the content we send it. Results are scores or yes/no answers, and they can be wrong.
- You decide what your rituals do with an Omen answer. Don't use Omens alone to make decisions with legal or similarly significant effects on a person.

## 13. Security

We use reasonable technical and organizational measures to protect Customer Data, as described in the [Privacy Policy](/legal/privacy#security). You must protect your credentials and tell us promptly about any suspected misuse at [support@bane.mx](mailto:support@bane.mx). We'll notify you of a security breach affecting your Customer Data as the law requires and, where one is signed, as the Data Processing Addendum requires.

## 14. Availability and support

- We work to keep Nightmail available, but we don't offer a service level agreement unless we agree one with you in writing.
- We may do maintenance, and may limit request rates to protect the Service.

## 15. Disclaimers

Except as stated in these Terms, the Service is provided **"as is" and "as available"**. To the extent the law allows, we disclaim all implied warranties, including merchantability, fitness for a particular purpose and non-infringement. We don't warrant that mail will be delivered, placed in an inbox, or received from any sender, or that screening and Omens will be accurate.

## 16. Limitation of liability

- Neither side is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data, even if told they were possible.
- Each side's total liability under these Terms is limited to the **greater of the amount you paid us in the 12 months before the claim, or $100**.
- These limits don't apply to your payment obligations, your indemnity ([section 17](#indemnity)), your breach of the Acceptable Use Policy, or liability that can't be limited by law.

## 17. Indemnity

You'll defend and indemnify Anomaly against third-party claims, fines and costs arising from your Customer Data, your mail and lists, your use of the Service in breach of these Terms or the Acceptable Use Policy, or your breach of law (including anti-spam and privacy laws).

## 18. Ending the agreement

- **You** can stop using Nightmail at any time. To close a workspace, email [support@bane.mx](mailto:support@bane.mx) from a workspace owner's address; to close your account, email us from your account's address.
- **We** can end these Terms or close a workspace:
  - for a serious or repeated breach, at once;
  - otherwise with **30 days'** notice. If we close a workspace without cause, we refund its unused, unexpired paid balance ([section 5.7](#refunds-and-credit-expiry)).
- If you close a workspace yourself, its unused credit isn't refunded ([section 5.7](#refunds-and-credit-expiry)).
- **Export.** You can read your messages, contacts and other data at any time through the API, SDK, MCP and IMAP. To export a whole workspace, email [support@bane.mx](mailto:support@bane.mx) and we'll help you do it.
- **After closing:** you have **30 days** to export your data, unless we closed the account for abuse or the law forbids it. After that, we delete the workspace's Customer Data from our active systems within 90 days, except:
  - billing and payment records, kept for **7 years** for tax and accounting;
  - the account's audit trail, kept for up to **1 year** (billing events 7 years);
  - unsubscribe and suppression records, where we need them to keep honoring opt-outs;
  - copies in backups, until those backups expire;
  - anything the law requires us to keep.
- Sections that by their nature should survive (payment, disclaimers, limitation of liability, indemnity, governing law and disputes) survive termination.

## 19. Changes to these Terms

We may update these Terms. For material changes we'll give at least **30 days'** notice by email to workspace owners and in the dashboard. If you keep using Nightmail after a change takes effect, the new Terms apply. If you don't agree, stop using Nightmail before then. [Section 5.7](#refunds-and-credit-expiry) governs any prepaid balance.

## 20. Governing law and disputes

### Choice of law

These Terms are governed by and will be construed under the Federal Arbitration Act, applicable federal law, and the laws of the State of Delaware, without regard to the conflicts of laws provisions thereof.

### Arbitration agreement

Please read the following ARBITRATION AGREEMENT carefully because it requires you to arbitrate certain disputes and claims with Anomaly and limits the manner in which you can seek relief from Anomaly. Both you and Anomaly acknowledge and agree that for the purposes of any dispute arising out of or relating to the subject matter of these Terms, Anomaly's officers, directors, employees and independent contractors ("Personnel") are third-party beneficiaries of these Terms, and that upon your acceptance of these Terms, Personnel will have the right (and will be deemed to have accepted the right) to enforce these Terms against you as the third-party beneficiary hereof.

#### (a) Arbitration rules; applicability of arbitration agreement

The parties shall use their best efforts to settle any dispute, claim, question, or disagreement arising out of or relating to the subject matter of these Terms directly through good-faith negotiations, which shall be a precondition to either party initiating arbitration. If such negotiations do not resolve the dispute, it shall be finally settled by binding arbitration in New Castle County, Delaware. The arbitration will proceed in the English language, in accordance with the JAMS Streamlined Arbitration Rules and Procedures (the "Rules") then in effect, by one commercial arbitrator with substantial experience in resolving intellectual property and commercial contract disputes. The arbitrator shall be selected from the appropriate list of JAMS arbitrators in accordance with such Rules. Judgment upon the award rendered by such arbitrator may be entered in any court of competent jurisdiction.

#### (b) Costs of arbitration

The Rules will govern payment of all arbitration fees. Anomaly will pay all arbitration fees for claims less than seventy-five thousand ($75,000) dollars. Anomaly will not seek its attorneys' fees and costs in arbitration unless the arbitrator determines that your claim is frivolous.

#### (c) Small claims court; infringement

Either you or Anomaly may assert claims, if they qualify, in small claims court in New Castle County, Delaware or any United States county where you live or work. Furthermore, notwithstanding the foregoing obligation to arbitrate disputes, each party shall have the right to pursue injunctive or other equitable relief at any time, from any court of competent jurisdiction, to prevent the actual or threatened infringement, misappropriation or violation of a party's copyrights, trademarks, trade secrets, patents or other intellectual property rights.

#### (d) Waiver of jury trial

YOU AND ANOMALY WAIVE ANY CONSTITUTIONAL AND STATUTORY RIGHTS TO GO TO COURT AND HAVE A TRIAL IN FRONT OF A JUDGE OR JURY. You and Anomaly are instead choosing to have claims and disputes resolved by arbitration. Arbitration procedures are typically more limited, more efficient, and less costly than rules applicable in court and are subject to very limited review by a court. In any litigation between you and Anomaly over whether to vacate or enforce an arbitration award, YOU AND ANOMALY WAIVE ALL RIGHTS TO A JURY TRIAL, and elect instead to have the dispute be resolved by a judge.

#### (e) Waiver of class or consolidated actions

ALL CLAIMS AND DISPUTES WITHIN THE SCOPE OF THIS ARBITRATION AGREEMENT MUST BE ARBITRATED OR LITIGATED ON AN INDIVIDUAL BASIS AND NOT ON A CLASS BASIS. CLAIMS OF MORE THAN ONE CUSTOMER OR USER CANNOT BE ARBITRATED OR LITIGATED JOINTLY OR CONSOLIDATED WITH THOSE OF ANY OTHER CUSTOMER OR USER. If however, this waiver of class or consolidated actions is deemed invalid or unenforceable, neither you nor Anomaly is entitled to arbitration; instead all claims and disputes will be resolved in a court as set forth in (g) below.

#### (f) Opt-out

You have the right to opt out of the provisions of this Section by sending written notice of your decision to opt out to the following address: Anomaly Innovations, Inc., 2443 Fillmore St #380-6343, San Francisco, CA 94115, United States, postmarked within thirty (30) days of first accepting these Terms. You must include (i) your name and address, (ii) the email address and/or telephone number associated with your account, and (iii) a clear statement that you want to opt out of these Terms' arbitration agreement.

#### (g) Exclusive venue

If you send the opt-out notice in (f), and/or in any circumstances where the foregoing arbitration agreement permits either you or Anomaly to litigate any dispute arising out of or relating to the subject matter of these Terms in court, then the foregoing arbitration agreement will not apply to either party, and both you and Anomaly agree that any judicial proceeding (other than small claims actions) will be brought in the state or federal courts located in, respectively, New Castle County, Delaware, or the federal district in which that county falls.

#### (h) Severability

If the prohibition against class actions and other claims brought on behalf of third parties contained above is found to be unenforceable, then all of the preceding language in this Arbitration Agreement section will be null and void. This arbitration agreement will survive the termination of your relationship with Anomaly.

## 21. General

- **Assignment.** You can't transfer these Terms without our prior written consent. We can transfer them in a merger, acquisition or sale of assets, or to an affiliate.
- **Force majeure.** Neither side is liable for delays caused by events beyond its reasonable control, including outages of the providers Nightmail depends on.
- **Notices.** We send notices to workspace owners' email addresses and in the dashboard. You send legal notices to [legal@bane.mx](mailto:legal@bane.mx), or by mail to the address in [section 22](#contact).
- **Entire agreement.** These Terms, the Acceptable Use Policy, the Privacy Policy, any signed Data Processing Addendum and any order form are the whole agreement between you and Anomaly about the Service. If they conflict, a signed agreement wins, then the Data Processing Addendum for personal data, then these Terms.
- **Severability and waiver.** If a part of these Terms is unenforceable, it's limited or removed to the minimum extent necessary and the rest stays in force. Not enforcing a term isn't a waiver.
- **Export and sanctions.** You'll comply with export control and sanctions laws.
- **Independent parties.** You and Anomaly are independent contractors. These Terms don't create a partnership, joint venture, employment or agency relationship.

## 22. Contact

Anomaly Innovations, Inc.\
2443 Fillmore St #380-6343, San Francisco, CA 94115, United States

- Support and billing: [support@bane.mx](mailto:support@bane.mx)
- Abuse reports: [abuse@bane.mx](mailto:abuse@bane.mx)
- Privacy and data requests: [privacy@bane.mx](mailto:privacy@bane.mx)
- Legal notices: [legal@bane.mx](mailto:legal@bane.mx)
