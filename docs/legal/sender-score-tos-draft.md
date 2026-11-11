# Terms of Service: automated content screening and sender score

> **DRAFT for legal review. Not published, not in force.** Do not link to this file from the product, the docs or the website until legal has approved the wording and its placement in the Terms of Service.

## Proposed clause

**Automated content screening.** To prevent fraud and abuse, Bane scans the content of email sent through, or received into, your account with an automated classifier. We use the results only to (a) prevent fraud, spam and other abuse of the Service, which may include holding, rejecting or reviewing messages, and (b) compute your account's sender score. We do not sell scanned content or classifier results, and we do not use them for advertising.

**Sender score.** Your sender score is calculated from your account's own sending and receiving activity, including classifier results, bounce and complaint rates, domain authentication, suppression-list hits and sending volume patterns. Your sender score may affect how we queue, review, pause or deliver your mail, as described in our documentation.

## Notes for legal review

- **What the product does today.**
  - Hosted sending screens message content with an automated classifier and rejects messages it scores as spam (`CONTENT_REJECTED_SPAM`).
  - A rejected email's event records the classifier's score and model. Nothing is recorded for messages that pass.
  - `GET /v1/sender-score` computes the score on request from stored sending data and stores nothing new.
- **"Sending and receiving activity."** The score's inputs today come from sending. The clause also names receiving, so that mail forwarded from receiving routes can be screened and scored later without changing the Terms.
- **"May affect how we queue, review, pause or deliver."** Today the score is informational. Rolling 24-hour caps on new hosted workspaces still apply separately. Confirm the wording before the score drives dispatch or review.
- **Human review.** The clause doesn't say whether people at Bane ever look at flagged content. Decide whether to state that, and under what conditions: for example, only for messages flagged as abuse, at the customer's request, or when the law requires.
- **Placement.** This belongs in the Acceptable Use and Data sections of the Terms. The privacy policy may need a matching processing purpose: fraud and abuse prevention as a legitimate interest.
