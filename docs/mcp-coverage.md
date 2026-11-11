# Hosted MCP operation coverage

Direct tools are named below. Where there is no direct tool, the reason or remaining gap is explicit. This inventory is checked against OpenAPI; adding an endpoint requires classifying it.

| Operation | Direct tool or disposition |
|---|---|
| `listMcpConnections` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `revokeMcpConnection` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `getCurrentIdentity` | `getContext` |
| `createAgentToken` | `createAgentToken` |
| `listAgentTokens` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `revokeAgentToken` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `createApiKey` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `listApiKeys` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `revokeApiKey` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `listContacts` | `findContacts` |
| `createContact` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getContact` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `updateContact` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteContact` | `deleteContact` |
| `updateContactConsent` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listContactConsentEvents` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listContactLists` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `createContactList` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getContactList` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `updateContactList` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteContactList` | `deleteList` |
| `listListMembers` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `addListMembers` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `removeListMember` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listSegments` | `findSegments` |
| `createSegment` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getSegment` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `updateSegment` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteSegment` | `deleteSegment` |
| `previewSegment` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `previewContactImport` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listContactImports` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getContactImport` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `commitContactImport` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `queryAudience` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `planAudienceMutation` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `applyAudiencePlan` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listCampaignTemplates` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `createCampaignTemplate` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getCampaignTemplate` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `updateCampaignTemplate` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteCampaignTemplate` | `deleteTemplate` |
| `publishCampaignTemplate` | `publishTemplate` |
| `previewCampaignTemplate` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `renderCampaignTemplatePreviewImage` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `setCampaignTemplateArchived` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `uploadTemplateAsset` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `importTemplateImage` | `importTemplateImage` |
| `getTemplateAsset` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteTemplateAsset` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getTemplateAssetContent` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `sendEmail` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `sendEmailBatch` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listEmails` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getEmail` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getEmailDetail` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getEmailContent` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listEmailEvents` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `uploadAttachment` | `uploadAttachment` |
| `getAttachment` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteAttachment` | `deleteAttachment` |
| `getAttachmentContent` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `createCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listCampaigns` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `updateCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `deleteCampaign` | `deleteCampaign` |
| `getCampaignStats` | `getCampaignStats` |
| `getCampaignContentGuide` | `getContentGuide` |
| `previewCampaign` | `previewCampaign` |
| `previewCampaignAudience` | `previewCampaignAudience` |
| `renderCampaignPreviewImage` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getCampaignState` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `setCampaignArchived` | `archiveCampaign` |
| `testCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `sendCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `scheduleCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `cancelCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `pauseCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `resumeCampaign` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `setCampaignPacing` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getWorkspaceSettings` | `admin_get_settings` |
| `updateWorkspaceSettings` | `admin_update_settings` |
| `getSesSettings` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listDomains` | `findDomains` |
| `createDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `configureDomainMailFrom` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `chooseReceivingHost` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `sendDomainTestEmail` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getDomainDnsSetup` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `completeDomainDnsSetup` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `getDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `deleteDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `verifyDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listWebhooks` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `createWebhook` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `getWebhook` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `updateWebhook` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `deleteWebhook` | `deleteWebhook` |
| `revealWebhookSecret` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `rotateWebhookSecret` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `testWebhook` | `testWebhook` |
| `listWebhookDeliveries` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getWebhookDelivery` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `retryWebhookDelivery` | `retryWebhookDelivery` |
| `receiveSesSnsEvent` | Provider-signed notification or recipient capability; never an agent RPC. |
| `unsubscribeByLink` | Provider-signed notification or recipient capability; never an agent RPC. |
| `unsubscribeOneClick` | Provider-signed notification or recipient capability; never an agent RPC. |
| `getMetrics` | `getMetrics` |
| `listRegions` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `configureRegion` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `discoverRegion` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `provisionRegion` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `configureRegionAutoValidation` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `getRouting` | `getRouting` |
| `applyRouting` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listRoutes` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `createRoute` | `routes_create` |
| `getRoute` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `updateRoute` | `routes_update` |
| `deleteRoute` | `routes_delete` |
| `getRoutingAudit` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listRoutingVersions` | `listRoutingVersions` |
| `getRoutingVersion` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `restoreRoutingVersion` | `routes_restore` |
| `testRouting` | `testRouting` |
| `listRitualVersions` | `rituals_versions` |
| `restoreRitualVersion` | `rituals_restore` |
| `setRitualEvaluation` | `rituals_set_omens` |
| `updateEndpoint` | `endpoints_update` |
| `getEndpoint` | `endpoints_get` |
| `deleteEndpoint` | `endpoints_delete` |
| `sendEndpointVerification` | `endpoints_send_verification` |
| `testEndpoint` | `endpoints_test` |
| `checkRitual` | `rituals_check` |
| `getRitualTypings` | `rituals_typings` |
| `listRitualTemplates` | `rituals_templates` |
| `listEndpoints` | `endpoints_list` |
| `createEndpoint` | `endpoints_create` |
| `createInboxConnection` | `inboxes_connect` |
| `getRitualEntry` | `rituals_get` |
| `putRitualEntry` | `rituals_create` |
| `deleteRitualEntry` | `rituals_delete` |
| `setRitualAttachments` | `rituals_attach` |
| `getRituals` | `getRituals` |
| `putRituals` | `rituals_apply` |
| `testRituals` | `testRituals` |
| `createInbox` | `inboxes_create` |
| `listInboxes` | `inboxes_list` |
| `getInbox` | `getInbox` |
| `updateInbox` | `inboxes_update` |
| `deleteInbox` | `inboxes_delete` |
| `simulateInboxMessage` | `inboxes_simulate` |
| `listInboxMessages` | `inboxes_list_messages` |
| `getInboxMessage` | `inboxes_read_message` |
| `updateInboxMessage` | `updateInboxMessage` |
| `getInboxAttachment` | `getInboxAttachment` |
| `releaseRetiredAddress` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `getInboundScanPolicy` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `updateInboundScanPolicy` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listInboundDomains` | `listInboundDomains` |
| `getInboundDomain` | `getInboundDomain` |
| `updateInboundDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `checkInboundDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `enableInboundDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `disableInboundDomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listInboundSubdomains` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `createInboundSubdomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `getInboundSubdomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `updateInboundSubdomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `removeInboundSubdomain` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listInboundAddresses` | `listInboundAddresses` |
| `createInboundAddress` | `inboxes_create_address` |
| `getInboundAddress` | `getInboundAddress` |
| `updateInboundAddress` | `inboxes_update_address` |
| `deleteInboundAddress` | `deleteInboundAddress` |
| `listInboundThreads` | `listInboundThreads` |
| `createInboundThread` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `getInboundThread` | `getInboundThread` |
| `updateInboundThread` | `updateInboundThread` |
| `listInboundMessages` | `listInboundMessages` |
| `getInboundMessage` | `getInboundMessage` |
| `getInboundAttachment` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `replyToInboundThread` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listInboundEvents` | `listInboundEvents` |
| `createInboundKey` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `listInboundKeys` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `revokeInboundKey` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `createInboundWebhook` | `endpoints_create_webhook` |
| `listInboundWebhooks` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `getInboundWebhook` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `updateInboundWebhook` | `endpoints_update_webhook` |
| `deleteInboundWebhook` | `endpoints_delete_webhook` |
| `testInboundWebhook` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `redeliverInboundMessage` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `rotateInboundWebhookSecret` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `retryInboundWebhookDelivery` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listInboundWebhookDeliveries` | No standalone binding: the outbound catalog exposes task workflows rather than every low-level write, binary response or preparation step. |
| `listWorkspaces` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `createWorkspace` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `renameCurrentWorkspace` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `listWorkspaceMembers` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `inviteWorkspaceMember` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `createWorkspaceInvitation` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `listWorkspaceInvitations` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `revokeWorkspaceInvitation` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `updateWorkspaceMember` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `removeWorkspaceMember` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `getWorkspaceInvitation` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `acceptWorkspaceInvitation` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `getConnection` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `createConnection` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `deleteConnection` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `listConnectionRegions` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `refreshConnectionScan` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `importConnectionDomains` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `getConnectionRegionStatus` | No direct tool: human/installation administration or credential delegation. Use inboxes_connect for bounded inbox keys. |
| `verifyConnection` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
| `getPublicStats` | Parity gap: REST/SDK operation not individually published in the hosted catalog. |
