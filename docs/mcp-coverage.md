# Hosted MCP coverage

Generated from the catalog by `bun run mcp:coverage` (the acceptance suite fails if this file is stale). Every API operation an agent can perform is a tool. A tool marked with an action covers the operation through that argument.

Connect to `/mcp` for the default tools (15 everyday tools plus `search_tools` and `describe_tool`, listed without output schemas to keep plain clients small; `describe_tool` returns them), `/mcp?toolsets=<names>` for toolsets (inboxes, routing, rituals, endpoints, sending, admin), or `/mcp?toolsets=all` for Code Mode clients. Toolsets change what is listed, never what a grant may call.

The remaining rows are human steps: OAuth consent, a forward recipient's confirmation link, browser redirects and account administration. Tools that start one return its status and the next step.

| Operation | Tool · toolset, or why it is a human step |
|---|---|
| `listMcpConnections` | `listMcpConnections` · admin |
| `revokeMcpConnection` | `revokeMcpConnection` · admin |
| `getCurrentIdentity` | `getContext` · admin |
| `createAgentToken` | `createAgentToken` · admin |
| `listAgentTokens` | `listAgentTokens` · admin |
| `revokeAgentToken` | `revokeAgentToken` · admin |
| `createApiKey` | `createApiKey` · admin |
| `listApiKeys` | `listApiKeys` · admin |
| `revokeApiKey` | `revokeApiKey` · admin |
| `listContacts` | `findContacts` · sending |
| `createContact` | `saveContact` (action: "create") · sending |
| `getContact` | `getContact` · sending |
| `updateContact` | `saveContact` (action: "update") · sending |
| `deleteContact` | `deleteContact` · sending |
| `updateContactConsent` | `saveContact` (action: "consent") · sending |
| `listContactConsentEvents` | `listContactConsentEvents` · sending |
| `listContactLists` | `findLists` · sending |
| `createContactList` | `saveList` (action: "create") · sending |
| `getContactList` | `findLists` · sending |
| `updateContactList` | `saveList` (action: "update") · sending |
| `deleteContactList` | `deleteList` · sending |
| `listListMembers` | `findLists` · sending |
| `addListMembers` | `setListMembers` (action: "add") · sending |
| `removeListMember` | `setListMembers` (action: "remove") · sending |
| `listSegments` | `findSegments` · sending |
| `createSegment` | `saveSegment` (action: "create") · sending |
| `getSegment` | `getSegment` · sending |
| `updateSegment` | `saveSegment` (action: "update") · sending |
| `deleteSegment` | `deleteSegment` · sending |
| `previewSegment` | `saveSegment` (action: "preview") · sending |
| `previewContactImport` | `importContacts` (action: "preview") · sending |
| `listContactImports` | `importContacts` (action: "list") · sending |
| `getContactImport` | `importContacts` (action: "get") · sending |
| `commitContactImport` | `importContacts` (action: "commit") · sending |
| `queryAudience` | `audienceQuery` · sending |
| `planAudienceMutation` | `audienceQuery` · sending |
| `applyAudiencePlan` | `audienceQuery` · sending |
| `listCampaignTemplates` | `findTemplates` · sending |
| `createCampaignTemplate` | `saveTemplate` (action: "create") · sending |
| `getCampaignTemplate` | `findTemplates` · sending |
| `updateCampaignTemplate` | `saveTemplate` (action: "update") · sending |
| `deleteCampaignTemplate` | `deleteTemplate` · sending |
| `publishCampaignTemplate` | `publishTemplate` · sending |
| `previewCampaignTemplate` | `previewTemplate` · sending |
| `renderCampaignTemplatePreviewImage` | `previewTemplate` · sending |
| `setCampaignTemplateArchived` | `saveTemplate` (action: "archive") · sending |
| `uploadTemplateAsset` | `uploadTemplateAsset` · sending |
| `importTemplateImage` | `importTemplateImage` · sending |
| `getTemplateAsset` | `getTemplateAsset` · sending |
| `deleteTemplateAsset` | `deleteTemplateAsset` · sending |
| `getTemplateAssetContent` | `getTemplateAssetContent` · sending |
| `sendEmail` | `sendEmail` (mode: "single") · sending |
| `sendEmailBatch` | `sendEmail` (mode: "batch") · sending |
| `listEmails` | `findEmails` · sending |
| `getEmail` | `findEmails` · sending |
| `getEmailDetail` | `getEmailDetail` · sending |
| `getEmailContent` | `findEmails` · sending |
| `listEmailEvents` | `findEmails` · sending |
| `uploadAttachment` | `uploadAttachment` · admin |
| `getAttachment` | `getAttachment` (include: "metadata") · admin |
| `deleteAttachment` | `deleteAttachment` · admin |
| `getAttachmentContent` | `getAttachment` (include: "content") · admin |
| `createCampaign` | `saveCampaign` (action: "create") · sending |
| `listCampaigns` | `findCampaigns` · sending |
| `getCampaign` | `findCampaigns` · sending |
| `updateCampaign` | `saveCampaign` (action: "update") · sending |
| `deleteCampaign` | `deleteCampaign` · sending |
| `getCampaignStats` | `getCampaignStats` · sending |
| `getCampaignContentGuide` | `getContentGuide` · sending |
| `previewCampaign` | `previewCampaign` · sending |
| `previewCampaignAudience` | `previewCampaignAudience` · sending |
| `renderCampaignPreviewImage` | `renderCampaignPreviewImage` · sending |
| `getCampaignState` | `getCampaignState` · sending |
| `setCampaignArchived` | `archiveCampaign` · sending |
| `testCampaign` | `deliverCampaign` (mode: "test") · sending |
| `sendCampaign` | `deliverCampaign` (mode: "send") · sending |
| `scheduleCampaign` | `deliverCampaign` (mode: "schedule") · sending |
| `cancelCampaign` | `deliverCampaign` (mode: "cancel") · sending |
| `pauseCampaign` | `deliverCampaign` (mode: "pause") · sending |
| `resumeCampaign` | `deliverCampaign` (mode: "resume") · sending |
| `setCampaignPacing` | `deliverCampaign` (mode: "pacing") · sending |
| `getWorkspaceSettings` | `getWorkspaceSettings` · admin |
| `updateWorkspaceSettings` | `updateWorkspaceSettings` · admin |
| `getSesSettings` | `getSesSettings` · admin |
| `listDomains` | `findDomains` · admin |
| `createDomain` | `saveDomain` (action: "create") · admin |
| `configureDomainMailFrom` | `saveDomain` (action: "mailFrom") · admin |
| `chooseReceivingHost` | `saveDomain` (action: "receivingHost") · admin |
| `sendDomainTestEmail` | Human step: sends only to the signed-in person’s own address. Agents use sendEmail. |
| `getDomainDnsSetup` | Human step: Domain Connect opens the DNS provider in a browser. Agents read DNS records from findDomains and saveDomain. |
| `completeDomainDnsSetup` | Human step: the DNS provider redirects the person’s browser back. |
| `getDomain` | `getDomain` · admin |
| `deleteDomain` | `deleteDomain` · admin |
| `verifyDomain` | `verifyDomain` · admin |
| `listWebhooks` | `findWebhooks` · admin |
| `createWebhook` | `saveWebhook` (action: "create") · admin |
| `getWebhook` | `findWebhooks` · admin |
| `updateWebhook` | `saveWebhook` (action: "update") · admin |
| `deleteWebhook` | `deleteWebhook` · admin |
| `revealWebhookSecret` | `revealWebhookSecret` · admin |
| `rotateWebhookSecret` | `rotateWebhookSecret` · admin |
| `testWebhook` | `testWebhook` · admin |
| `listWebhookDeliveries` | `findWebhooks` · admin |
| `getWebhookDelivery` | `getWebhookDelivery` · admin |
| `retryWebhookDelivery` | `retryWebhookDelivery` · admin |
| `receiveSesSnsEvent` | Signed by Amazon SNS; never an agent call. |
| `unsubscribeByLink` | Recipient capability link; never an agent call. |
| `unsubscribeOneClick` | Recipient one-click unsubscribe; never an agent call. |
| `getMetrics` | `getMetrics` · sending |
| `listRegions` | `listRegions` · admin |
| `configureRegion` | `configureRegion` · admin |
| `discoverRegion` | `discoverRegion` · admin |
| `provisionRegion` | `provisionRegion` · admin |
| `configureRegionAutoValidation` | `configureRegionAutoValidation` · admin |
| `getRouting` | `getRouting` · routing |
| `applyRouting` | `applyRouting` · routing |
| `listRoutes` | `listRoutes` · routing |
| `createRoute` | `createRoute` · routing |
| `getRoute` | `getRoute` · routing |
| `updateRoute` | `updateRoute` · routing |
| `deleteRoute` | `deleteRoute` · routing |
| `getRoutingAudit` | `getRoutingAudit` · routing |
| `listRoutingVersions` | `listRoutingVersions` · routing |
| `getRoutingVersion` | `getRoutingVersion` · routing |
| `restoreRoutingVersion` | `restoreRoutingVersion` · routing |
| `testRouting` | `testRouting` · routing |
| `listRitualVersions` | `listRitualVersions` · rituals |
| `restoreRitualVersion` | `restoreRitualVersion` · rituals |
| `setOmenOptIns` | `setOmenOptIns` · rituals |
| `listEndpoints` | `listEndpoints` · endpoints |
| `createEndpoint` | `createEndpoint` · endpoints |
| `getEndpoint` | `getEndpoint` · endpoints |
| `updateEndpoint` | `updateEndpoint` · endpoints |
| `deleteEndpoint` | `deleteEndpoint` · endpoints |
| `sendEndpointVerification` | `sendEndpointVerification` · endpoints |
| `testEndpoint` | `testEndpoint` · endpoints |
| `createInboxConnection` | `createInboxConnection` · inboxes |
| `checkRitual` | `checkRitual` · rituals |
| `getRitualTypings` | `getRitualTypings` · rituals |
| `listRitualTemplates` | `listRitualTemplates` · rituals |
| `getRitual` | `getRitual` · rituals |
| `saveRitual` | `saveRitual` · rituals |
| `deleteRitual` | `deleteRitual` · rituals |
| `attachRituals` | `attachRituals` · rituals |
| `getRituals` | `getRituals` · rituals |
| `applyRituals` | `applyRituals` · rituals |
| `testRituals` | `testRituals` · rituals |
| `createInbox` | `createInbox` · inboxes |
| `listInboxes` | `listInboxes` · inboxes |
| `getInbox` | `getInbox` · inboxes |
| `updateInbox` | `updateInbox` · inboxes |
| `deleteInbox` | `deleteInbox` · inboxes |
| `simulateInboxMessage` | `simulateInboxMessage` · inboxes |
| `listInboxMessages` | `listInboxMessages` · inboxes |
| `getInboxMessage` | `readInboxMessage` · inboxes |
| `updateInboxMessage` | `updateInboxMessage` · inboxes |
| `getInboxAttachment` | `getInboxAttachment` · inboxes |
| `releaseRetiredAddress` | `releaseRetiredAddress` · inboxes |
| `getInboundScanPolicy` | `getInboundScanPolicy` · admin |
| `updateInboundScanPolicy` | `updateInboundScanPolicy` · admin |
| `listInboundDomains` | `listInboundDomains` · admin |
| `getInboundDomain` | `getInboundDomain` · admin |
| `updateInboundDomain` | `updateInboundDomain` · admin |
| `checkInboundDomain` | `checkInboundDomain` · admin |
| `enableInboundDomain` | `enableInboundDomain` · admin |
| `disableInboundDomain` | `disableInboundDomain` · admin |
| `listInboundSubdomains` | `listInboundSubdomains` · admin |
| `createInboundSubdomain` | `createInboundSubdomain` · admin |
| `getInboundSubdomain` | `getInboundSubdomain` · admin |
| `updateInboundSubdomain` | `updateInboundSubdomain` · admin |
| `removeInboundSubdomain` | `removeInboundSubdomain` · admin |
| `listInboundAddresses` | `listInboundAddresses` · inboxes |
| `createInboundAddress` | `saveInboundAddress` (action: "create") · inboxes |
| `getInboundAddress` | `getInboundAddress` · inboxes |
| `updateInboundAddress` | `saveInboundAddress` (action: "update") · inboxes |
| `deleteInboundAddress` | `deleteInboundAddress` · inboxes |
| `listInboundThreads` | `listInboundThreads` · inboxes |
| `createInboundThread` | `sendInboundThread` (mode: "start") · inboxes |
| `getInboundThread` | `getInboundThread` · inboxes |
| `updateInboundThread` | `updateInboundThread` · inboxes |
| `listInboundMessages` | `listInboundMessages` · inboxes |
| `getInboundMessage` | `getInboundMessage` · inboxes |
| `getInboundAttachment` | `getInboundAttachment` · inboxes |
| `replyToInboundThread` | `sendInboundThread` (mode: "reply") · inboxes |
| `listInboundEvents` | `listInboundEvents` · inboxes |
| `createInboundKey` | `createInboundKey` · admin |
| `listInboundKeys` | `listInboundKeys` · admin |
| `revokeInboundKey` | `revokeInboundKey` · admin |
| `createInboundWebhook` | `createInboundWebhook` · endpoints |
| `listInboundWebhooks` | `listInboundWebhooks` · endpoints |
| `getInboundWebhook` | `getInboundWebhook` · endpoints |
| `updateInboundWebhook` | `updateInboundWebhook` · endpoints |
| `deleteInboundWebhook` | `deleteInboundWebhook` · endpoints |
| `testInboundWebhook` | `testInboundWebhook` · endpoints |
| `redeliverInboundMessage` | `redeliverInboundMessage` · endpoints |
| `rotateInboundWebhookSecret` | `rotateInboundWebhookSecret` · endpoints |
| `retryInboundWebhookDelivery` | `retryInboundWebhookDelivery` · endpoints |
| `listInboundWebhookDeliveries` | `listInboundWebhookDeliveries` · endpoints |
| `listWorkspaces` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `createWorkspace` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `renameCurrentWorkspace` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `listWorkspaceMembers` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `inviteWorkspaceMember` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `createWorkspaceInvitation` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `listWorkspaceInvitations` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `revokeWorkspaceInvitation` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `updateWorkspaceMember` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `removeWorkspaceMember` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `getWorkspaceInvitation` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `acceptWorkspaceInvitation` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `getConnection` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `createConnection` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `deleteConnection` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `listConnectionRegions` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `refreshConnectionScan` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `importConnectionDomains` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `getConnectionRegionStatus` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `verifyConnection` | Human step: account administration in a signed-in dashboard session (members, invitations, workspaces, BYO AWS). |
| `getPublicStats` | Public, installation-wide homepage numbers; no workspace data. |
