//! REST authorization for every MCP catalog operation, written from the REST code (handlers and
//! middleware), not from the MCP catalog. The runner compares each actor's MCP listing (both
//! catalogs) with `allows`, and `audit` probes real REST for every GET to check this table.
//!
//! When a route is added or its check changes, add or update its row here: an operation the
//! listing shows that this table lacks is a mismatch.

/// The authorization check a handler performs for a workspace credential (after the path guards).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    /// No permission check at all (getCurrentIdentity): any authenticated actor.
    Any,
    /// actor(c), actor(c, 'read'), workspaceActor(c), region reads.
    Read,
    /// actor(c, 'send'), campaign control().
    Send,
    /// actor(c, 'manage'), editContent (manage for machine credentials), manageKeys(),
    /// manageTemplates(), workspaceActor(c, 'manage'), region writes.
    Manage,
    /// createAgentToken: an MCP approval may delegate a token within its own permissions.
    Delegate,
    /// dashboardOwner(): a signed-in dashboard session only.
    Dashboard,
    /// ritualAdmin(c): read with receiving consent, else manage; never a member.
    RitualRead,
    /// ritualAdmin(c, true): manage, receiving consent for a grant, never a member.
    RitualWrite,
    /// routing workspace(): GETs and the dry run need read with receiving consent, else manage.
    RoutingRead,
    /// Mailbox handler admin(c) / readAccess(c): an admin mailbox access (manage) only.
    MailboxAdmin,
    /// Mailbox access(c, permission) ("" = access(c)): admin, or an inbox key with the permission.
    MailboxAccess(&'static str),
    /// manageHook(): admin, and receiving consent for a grant.
    MailboxHook,
    /// createInboundKey: admin, and ownReceiving() (receiving consent and manage) for a grant.
    MailboxOwnReceiving,
}

/// (operationId, method, OpenAPI path, check), for the 201 operations of the hosted MCP catalog.
pub const OPS: &[(&str, &str, &str, Check)] = &[
    ("addListMembers", "post", "/v1/lists/{id}/members", Check::Manage),
    ("applyAudiencePlan", "post", "/v1/audience-query/apply", Check::Manage),
    ("applyRituals", "put", "/v1/rituals", Check::RitualWrite),
    ("applyRouting", "put", "/v1/routing", Check::Manage),
    ("attachRituals", "put", "/v1/rituals/attachments", Check::RitualWrite),
    ("cancelCampaign", "post", "/v1/campaigns/{id}/cancel", Check::Send),
    ("checkInboundDomain", "post", "/v1/inbound/domains/{id}/check", Check::MailboxAdmin),
    ("checkRitual", "post", "/v1/rituals/check", Check::RitualRead),
    ("chooseReceivingHost", "post", "/v1/domains/{id}/receiving-host", Check::Manage),
    ("commitContactImport", "post", "/v1/contact-imports/{id}/commit", Check::Manage),
    ("configureDomainMailFrom", "post", "/v1/domains/{id}/mail-from", Check::Manage),
    ("configureRegion", "put", "/v1/regions/{region}", Check::Manage),
    ("configureRegionAutoValidation", "put", "/v1/regions/{region}/auto-validation", Check::Manage),
    ("copyInboxMessage", "post", "/v1/inboxes/{id}/messages/{messageId}/copy", Check::MailboxAccess("modify")),
    ("createAgentToken", "post", "/v1/agent-tokens", Check::Delegate),
    ("createApiKey", "post", "/v1/api-keys", Check::Manage),
    ("createCampaign", "post", "/v1/campaigns", Check::Send),
    ("createCampaignTemplate", "post", "/v1/templates", Check::Manage),
    ("createContact", "post", "/v1/contacts", Check::Manage),
    ("createContactList", "post", "/v1/lists", Check::Manage),
    ("createDomain", "post", "/v1/domains", Check::Manage),
    ("createEndpoint", "post", "/v1/endpoints", Check::RitualWrite),
    ("createInboundAddress", "post", "/v1/inbound/addresses", Check::MailboxAdmin),
    ("createInboundKey", "post", "/v1/inbound/keys", Check::MailboxOwnReceiving),
    ("createInboundSubdomain", "post", "/v1/inbound/domains/{id}/subdomains", Check::MailboxAdmin),
    ("createInboundThread", "post", "/v1/inbound/threads", Check::MailboxAccess("send")),
    ("createInboundWebhook", "post", "/v1/inbound/webhooks", Check::MailboxHook),
    ("createInbox", "post", "/v1/inboxes", Check::MailboxAccess("create")),
    ("createInboxConnection", "post", "/v1/inbox-connections", Check::RitualWrite),
    ("createRoute", "post", "/v1/routing/routes", Check::Manage),
    ("createSegment", "post", "/v1/segments", Check::Manage),
    ("createWebhook", "post", "/v1/webhooks", Check::Manage),
    ("deleteAttachment", "delete", "/v1/attachments/{id}", Check::Send),
    ("deleteCampaign", "delete", "/v1/campaigns/{id}", Check::Send),
    ("deleteCampaignTemplate", "delete", "/v1/templates/{id}", Check::Manage),
    ("deleteContact", "delete", "/v1/contacts/{id}", Check::Manage),
    ("deleteContactList", "delete", "/v1/lists/{id}", Check::Manage),
    ("deleteDomain", "delete", "/v1/domains/{id}", Check::Manage),
    ("deleteEndpoint", "delete", "/v1/endpoints/{name}", Check::RitualWrite),
    ("deleteInboundAddress", "delete", "/v1/inbound/addresses/{addressId}", Check::MailboxAdmin),
    ("deleteInboundWebhook", "delete", "/v1/inbound/webhooks/{id}", Check::MailboxHook),
    ("deleteInbox", "delete", "/v1/inboxes/{id}", Check::MailboxAccess("modify")),
    ("deleteInboxMessage", "delete", "/v1/inboxes/{id}/messages/{messageId}", Check::MailboxAccess("modify")),
    ("deleteRitual", "delete", "/v1/rituals/scripts/{key}", Check::RitualWrite),
    ("deleteRoute", "delete", "/v1/routing/routes/{id}", Check::Manage),
    ("deleteSegment", "delete", "/v1/segments/{id}", Check::Manage),
    ("deleteTemplateAsset", "delete", "/v1/template-assets/{id}", Check::Manage),
    ("deleteWebhook", "delete", "/v1/webhooks/{id}", Check::Manage),
    ("disableInboundDomain", "post", "/v1/inbound/domains/{id}/disable", Check::MailboxAdmin),
    ("discoverRegion", "get", "/v1/regions/{region}/discovery", Check::Read),
    ("enableInboundDomain", "post", "/v1/inbound/domains/{id}/enable", Check::MailboxAdmin),
    ("expungeInboxFolder", "post", "/v1/inboxes/{id}/folders/{folder}/expunge", Check::MailboxAccess("modify")),
    ("getAttachment", "get", "/v1/attachments/{id}", Check::Read),
    ("getAttachmentContent", "get", "/v1/attachments/{id}/content", Check::Read),
    ("getCampaign", "get", "/v1/campaigns/{id}", Check::Read),
    ("getCampaignContentGuide", "get", "/v1/campaign-content-guide", Check::Read),
    ("getCampaignState", "get", "/v1/campaigns/{id}/state", Check::Read),
    ("getCampaignStats", "get", "/v1/campaigns/{id}/stats", Check::Read),
    ("getCampaignTemplate", "get", "/v1/templates/{id}", Check::Read),
    ("getContact", "get", "/v1/contacts/{id}", Check::Read),
    ("getContactImport", "get", "/v1/contact-imports/{id}", Check::Read),
    ("getContactList", "get", "/v1/lists/{id}", Check::Read),
    ("getCurrentIdentity", "get", "/v1/me", Check::Any),
    ("getDomain", "get", "/v1/domains/{id}", Check::Read),
    ("getEmail", "get", "/v1/emails/{id}", Check::Read),
    ("getEmailContent", "get", "/v1/emails/{id}/content", Check::Read),
    ("getEmailDetail", "get", "/v1/emails/{id}/detail", Check::Read),
    ("getEndpoint", "get", "/v1/endpoints/{name}", Check::RitualRead),
    ("getInboundAddress", "get", "/v1/inbound/addresses/{addressId}", Check::MailboxAccess("read")),
    ("getInboundAttachment", "get", "/v1/inbound/messages/{messageId}/attachments/{attachmentId}", Check::MailboxAccess("read")),
    ("getInboundDomain", "get", "/v1/inbound/domains/{id}", Check::MailboxAdmin),
    ("getInboundMessage", "get", "/v1/inbound/messages/{messageId}", Check::MailboxAccess("read")),
    ("getInboundScanPolicy", "get", "/v1/inbound/policy", Check::MailboxAdmin),
    ("getInboundSubdomain", "get", "/v1/inbound/domains/{id}/subdomains/{subdomainId}", Check::MailboxAdmin),
    ("getInboundThread", "get", "/v1/inbound/threads/{threadId}", Check::MailboxAccess("read")),
    ("getInboundWebhook", "get", "/v1/inbound/webhooks/{id}", Check::MailboxAdmin),
    ("getInbox", "get", "/v1/inboxes/{id}", Check::MailboxAccess("read")),
    ("getInboxAttachment", "get", "/v1/inboxes/{id}/messages/{messageId}/attachments/{attachmentId}", Check::MailboxAccess("read")),
    ("getInboxChanges", "get", "/v1/inboxes/{id}/changes", Check::MailboxAccess("read")),
    ("getInboxMessage", "get", "/v1/inboxes/{id}/messages/{messageId}", Check::MailboxAccess("read")),
    ("getMetrics", "get", "/v1/metrics", Check::Read),
    ("getRitual", "get", "/v1/rituals/scripts/{key}", Check::RitualRead),
    ("getRitualTypings", "get", "/v1/rituals/typings", Check::RitualRead),
    ("getRituals", "get", "/v1/rituals", Check::RitualRead),
    ("getRoute", "get", "/v1/routing/routes/{id}", Check::RoutingRead),
    ("getRouting", "get", "/v1/routing", Check::RoutingRead),
    ("getRoutingAudit", "get", "/v1/routing/audit", Check::RoutingRead),
    ("getRoutingVersion", "get", "/v1/routing/versions/{v}", Check::RoutingRead),
    ("getSegment", "get", "/v1/segments/{id}", Check::Read),
    ("getSenderScore", "get", "/v1/sender-score", Check::Read),
    ("getSesSettings", "get", "/v1/settings/ses", Check::Read),
    ("getTemplateAsset", "get", "/v1/template-assets/{id}", Check::Read),
    ("getTemplateAssetContent", "get", "/v1/template-assets/{id}/content", Check::Read),
    ("getWebhook", "get", "/v1/webhooks/{id}", Check::Read),
    ("getWebhookDelivery", "get", "/v1/webhooks/{id}/deliveries/{deliveryId}", Check::Read),
    ("getWorkspaceSettings", "get", "/v1/settings/workspace", Check::Read),
    ("importTemplateImage", "post", "/v1/template-assets/import", Check::Manage),
    ("listAgentTokens", "get", "/v1/agent-tokens", Check::Manage),
    ("listApiKeys", "get", "/v1/api-keys", Check::Manage),
    ("listCampaignTemplates", "get", "/v1/templates", Check::Read),
    ("listCampaigns", "get", "/v1/campaigns", Check::Read),
    ("listContactConsentEvents", "get", "/v1/contacts/{id}/consent", Check::Read),
    ("listContactImports", "get", "/v1/contact-imports", Check::Read),
    ("listContactLists", "get", "/v1/lists", Check::Read),
    ("listContacts", "get", "/v1/contacts", Check::Read),
    ("listDomains", "get", "/v1/domains", Check::Read),
    ("listEmailEvents", "get", "/v1/emails/{id}/events", Check::Read),
    ("listEmails", "get", "/v1/emails", Check::Read),
    ("listEndpoints", "get", "/v1/endpoints", Check::RitualRead),
    ("listInboundAddresses", "get", "/v1/inbound/addresses", Check::MailboxAccess("read")),
    ("listInboundDomains", "get", "/v1/inbound/domains", Check::MailboxAdmin),
    ("listInboundEvents", "get", "/v1/inbound/events", Check::MailboxAccess("read")),
    ("listInboundKeys", "get", "/v1/inbound/keys", Check::MailboxAdmin),
    ("listInboundMessages", "get", "/v1/inbound/messages", Check::MailboxAccess("read")),
    ("listInboundSubdomains", "get", "/v1/inbound/domains/{id}/subdomains", Check::MailboxAdmin),
    ("listInboundThreads", "get", "/v1/inbound/threads", Check::MailboxAccess("read")),
    ("listInboundWebhookDeliveries", "get", "/v1/inbound/webhooks/{id}/deliveries", Check::MailboxAdmin),
    ("listInboundWebhooks", "get", "/v1/inbound/webhooks", Check::MailboxAdmin),
    ("listInboxFolders", "get", "/v1/inboxes/{id}/folders", Check::MailboxAccess("read")),
    ("listInboxMessages", "get", "/v1/inboxes/{id}/messages", Check::MailboxAccess("read")),
    ("listInboxes", "get", "/v1/inboxes", Check::MailboxAccess("read")),
    ("listListMembers", "get", "/v1/lists/{id}/members", Check::Read),
    ("listLogs", "get", "/v1/logs", Check::Read),
    ("listMcpConnections", "get", "/v1/mcp-connections", Check::Dashboard),
    ("listRegions", "get", "/v1/regions", Check::Read),
    ("listRitualTemplates", "get", "/v1/rituals/templates", Check::RitualRead),
    ("listRitualVersions", "get", "/v1/rituals/history", Check::RitualRead),
    ("listRoutes", "get", "/v1/routing/routes", Check::RoutingRead),
    ("listRoutingVersions", "get", "/v1/routing/versions", Check::RoutingRead),
    ("listSegments", "get", "/v1/segments", Check::Read),
    ("listWebhookDeliveries", "get", "/v1/webhooks/{id}/deliveries", Check::Read),
    ("listWebhooks", "get", "/v1/webhooks", Check::Read),
    ("moveInboxMessage", "post", "/v1/inboxes/{id}/messages/{messageId}/move", Check::MailboxAccess("modify")),
    ("pauseCampaign", "post", "/v1/campaigns/{id}/pause", Check::Send),
    ("planAudienceMutation", "post", "/v1/audience-query/plan", Check::Manage),
    ("previewCampaign", "get", "/v1/campaigns/{id}/preview", Check::Read),
    ("previewCampaignAudience", "get", "/v1/campaigns/{id}/audience", Check::Read),
    ("previewCampaignTemplate", "get", "/v1/templates/{id}/preview", Check::Read),
    ("previewContactImport", "post", "/v1/contact-imports", Check::Manage),
    ("previewSegment", "post", "/v1/segments/{id}/preview", Check::Read),
    ("provisionRegion", "post", "/v1/regions/{region}/provision", Check::Manage),
    ("publishCampaignTemplate", "post", "/v1/templates/{id}/publish", Check::Manage),
    ("queryAudience", "post", "/v1/audience-query/query", Check::Read),
    ("redeliverInboundMessage", "post", "/v1/inbound/messages/{messageId}/redeliver", Check::MailboxAdmin),
    ("releaseRetiredAddress", "delete", "/v1/inbound/retired/{address}", Check::MailboxAdmin),
    ("removeInboundSubdomain", "delete", "/v1/inbound/domains/{id}/subdomains/{subdomainId}", Check::MailboxAdmin),
    ("removeListMember", "delete", "/v1/lists/{id}/members/{contactId}", Check::Manage),
    ("renderCampaignPreviewImage", "get", "/v1/campaigns/{id}/preview-image", Check::Send),
    ("renderCampaignTemplatePreviewImage", "get", "/v1/templates/{id}/preview-image", Check::Send),
    ("replyToInboundThread", "post", "/v1/inbound/threads/{threadId}/reply", Check::MailboxAccess("send")),
    ("restoreRitualVersion", "post", "/v1/rituals/restore", Check::RitualWrite),
    ("restoreRoutingVersion", "post", "/v1/routing/versions/{v}/restore", Check::Manage),
    ("resumeCampaign", "post", "/v1/campaigns/{id}/resume", Check::Send),
    ("retryInboundWebhookDelivery", "post", "/v1/inbound/webhooks/{id}/deliveries/{deliveryId}/retry", Check::MailboxAdmin),
    ("retryWebhookDelivery", "post", "/v1/webhooks/{id}/deliveries/{deliveryId}/retry", Check::Manage),
    ("revealWebhookSecret", "get", "/v1/webhooks/{id}/secret", Check::Manage),
    ("revokeAgentToken", "post", "/v1/agent-tokens/{id}/revoke", Check::Manage),
    ("revokeApiKey", "post", "/v1/api-keys/{id}/revoke", Check::Manage),
    ("revokeInboundKey", "post", "/v1/inbound/keys/{id}/revoke", Check::MailboxAdmin),
    ("revokeMcpConnection", "post", "/v1/mcp-connections/{id}/revoke", Check::Dashboard),
    ("rotateInboundWebhookSecret", "post", "/v1/inbound/webhooks/{id}/rotate-secret", Check::MailboxHook),
    ("rotateWebhookSecret", "post", "/v1/webhooks/{id}/rotate-secret", Check::Manage),
    ("saveRitual", "put", "/v1/rituals/scripts/{key}", Check::RitualWrite),
    ("scheduleCampaign", "post", "/v1/campaigns/{id}/schedule", Check::Send),
    ("sendCampaign", "post", "/v1/campaigns/{id}/send", Check::Send),
    ("sendEmail", "post", "/v1/emails/send", Check::Send),
    ("sendEmailBatch", "post", "/v1/emails/batch", Check::Send),
    ("sendEndpointVerification", "post", "/v1/endpoints/{name}/verification", Check::RitualWrite),
    ("setCampaignArchived", "patch", "/v1/campaigns/{id}/archive", Check::Send),
    ("setCampaignPacing", "post", "/v1/campaigns/{id}/pacing", Check::Send),
    ("setCampaignTemplateArchived", "patch", "/v1/templates/{id}/archive", Check::Manage),
    ("setOmenOptIns", "put", "/v1/rituals/omens", Check::RitualWrite),
    ("simulateInboxMessage", "post", "/v1/inboxes/{id}/simulate", Check::MailboxAccess("modify")),
    ("testCampaign", "post", "/v1/campaigns/{id}/test", Check::Send),
    ("testEndpoint", "post", "/v1/endpoints/{name}/test", Check::RitualWrite),
    ("testInboundWebhook", "post", "/v1/inbound/webhooks/{id}/test", Check::MailboxAdmin),
    ("testRituals", "post", "/v1/rituals/test", Check::RitualRead),
    ("testRouting", "post", "/v1/routing/test", Check::RoutingRead),
    ("testWebhook", "post", "/v1/webhooks/{id}/test", Check::Manage),
    ("updateCampaign", "patch", "/v1/campaigns/{id}", Check::Send),
    ("updateCampaignTemplate", "patch", "/v1/templates/{id}", Check::Manage),
    ("updateContact", "patch", "/v1/contacts/{id}", Check::Manage),
    ("updateContactConsent", "post", "/v1/contacts/{id}/consent", Check::Manage),
    ("updateContactList", "patch", "/v1/lists/{id}", Check::Manage),
    ("updateEndpoint", "patch", "/v1/endpoints/{name}", Check::RitualWrite),
    ("updateInboundAddress", "patch", "/v1/inbound/addresses/{addressId}", Check::MailboxAdmin),
    ("updateInboundDomain", "patch", "/v1/inbound/domains/{id}", Check::MailboxAdmin),
    ("updateInboundScanPolicy", "patch", "/v1/inbound/policy", Check::MailboxAdmin),
    ("updateInboundSubdomain", "patch", "/v1/inbound/domains/{id}/subdomains/{subdomainId}", Check::MailboxAdmin),
    ("updateInboundThread", "patch", "/v1/inbound/threads/{threadId}", Check::MailboxAccess("modify")),
    ("updateInboundWebhook", "patch", "/v1/inbound/webhooks/{id}", Check::MailboxHook),
    ("updateInbox", "patch", "/v1/inboxes/{id}", Check::MailboxAccess("modify")),
    ("updateInboxMessage", "patch", "/v1/inboxes/{id}/messages/{messageId}", Check::MailboxAccess("modify")),
    ("updateRoute", "patch", "/v1/routing/routes/{id}", Check::Manage),
    ("updateSegment", "patch", "/v1/segments/{id}", Check::Manage),
    ("updateWebhook", "patch", "/v1/webhooks/{id}", Check::Manage),
    ("updateWorkspaceSettings", "patch", "/v1/settings/workspace", Check::Manage),
    ("uploadAttachment", "post", "/v1/attachments", Check::Send),
    ("uploadTemplateAsset", "post", "/v1/template-assets", Check::Manage),
    ("verifyDomain", "post", "/v1/domains/{id}/verify", Check::Manage),
    ("waitForMessage", "get", "/v1/inboxes/{id}/messages", Check::MailboxAccess("read")),
];

/// mailboxAuth (mailbox.ts): /v1/inbound/* and /v1/inboxes/* take inbox keys, or a workspace
/// credential through actorMailAccess, which for an MCP or API-key actor requires manage.
pub fn mailbox_path(path: &str) -> bool {
    path == "/v1/inbound" || path.starts_with("/v1/inbound/") || path == "/v1/inboxes" || path.starts_with("/v1/inboxes/")
}

/// requireReceivingConsent (app.ts and mailbox.ts): a grant without receiving consent is refused.
pub fn receiving_path(path: &str) -> bool {
    let under = |base: &str| path == base || path.starts_with(&format!("{base}/"));
    ["/v1/routing", "/v1/rituals", "/v1/endpoints", "/v1/inbound/retired", "/v1/inbound/domains", "/v1/inbound/addresses", "/v1/inbound/keys", "/v1/inbound/webhooks"]
        .into_iter()
        .any(under)
        || matches!(path, "/v1/inbox-connections" | "/v1/domains/{id}/receiving-host" | "/v1/inbound/policy" | "/v1/inbound/messages/{messageId}/redeliver")
}

/// notMember (app.ts): workspace members are refused these areas whatever their scopes.
pub fn owner_area(method: &str, path: &str) -> bool {
    let under = |base: &str| path == base || path.starts_with(&format!("{base}/"));
    under("/v1/domains") || under("/v1/webhooks") || under("/v1/agent-tokens") || path.starts_with("/v1/regions/") || (path == "/v1/regions" && method != "get")
        || path == "/v1/settings/ses"
        || (method == "post" && ["send", "schedule", "pause", "resume", "pacing", "cancel"].iter().any(|a| path == format!("/v1/campaigns/{{id}}/{a}")))
}

/// A workspace MCP grant: its granted permissions, the role it was approved under, and receiving consent.
pub struct Grant {
    pub read: bool,
    pub send: bool,
    pub manage: bool,
    pub member: bool,
    pub receiving: bool,
}

/// Whether REST authorizes this operation for the grant (dispatched as its MCP actor).
pub fn grant_allows(g: &Grant, method: &str, path: &str, check: Check) -> bool {
    let has = |p: &str| g.manage || match p { "read" => g.read, "send" => g.send, _ => false };
    if mailbox_path(path) && !g.manage {
        return false;
    }
    if receiving_path(path) && !g.receiving {
        return false;
    }
    if owner_area(method, path) && g.member {
        return false;
    }
    match check {
        // GET /v1/me reads c.get('actor'): any authenticated actor, whatever its permissions.
        Check::Any => true,
        Check::Read | Check::Delegate => has("read"),
        Check::Send => has("send"),
        Check::Manage => g.manage,
        Check::Dashboard => false,
        Check::RitualRead | Check::RoutingRead => (if g.receiving { has("read") } else { g.manage }) && !g.member,
        Check::RitualWrite => g.manage && !g.member && g.receiving,
        Check::MailboxAdmin | Check::MailboxAccess(_) => true,
        Check::MailboxHook | Check::MailboxOwnReceiving => g.receiving,
    }
}

/// Whether REST authorizes this operation for an inbox key with these permissions.
pub fn inbox_key_allows(permissions: &[&str], path: &str, check: Check) -> bool {
    mailbox_path(path) && match check {
        Check::MailboxAccess("") => true,
        Check::MailboxAccess(p) => permissions.contains(&p),
        _ => false,
    }
}

/// MCP policy, not REST: an inbox-scoped connection is offered only the agent-inbox tools
/// (/v1/inboxes/* and replies), never a new thread ("read, wait and permitted replies").
pub fn offered_to_inbox(name: &str, path: &str) -> bool {
    name != "createInboundThread" && (path == "/v1/inboxes" || path.starts_with("/v1/inboxes/") || name == "replyToInboundThread")
}
