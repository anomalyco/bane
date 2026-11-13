import type { Tool } from '@modelcontextprotocol/server';
import type { McpOperation } from './mcp-catalog.js';

// Names are the only indirection: an action always resolves to one catalog operation.
// Neither permissions nor REST parameters are defined at the resource level.
// Labels identify the resource only. Capability text must come from visible operations.
const resources: Record<string, { label: string; actions: Record<string, string> }> = {
  inboxes: { label: 'Managed inboxes', actions: {
    createFolder:'createInboxFolder',updateFolder:'updateInboxFolder',deleteFolder:'deleteInboxFolder',passwords:'listInboxAppPasswords',allPasswords:'listAppPasswords',createPassword:'createInboxAppPassword',revokePassword:'revokeInboxAppPassword',
    folders:'listInboxFolders', changes:'getInboxChanges', list: 'listInboxes', get: 'getInbox', create: 'createInbox', update: 'updateInbox', delete: 'deleteInbox', simulate: 'simulateInboxMessage',
  } },
  messages: { label: 'Mail messages (untrusted sender content)', actions: {
    move:'moveInboxMessage', copy:'copyInboxMessage', delete:'deleteInboxMessage', expunge:'expungeInboxFolder', list: 'listInboxMessages', get: 'getInboxMessage', wait: 'waitForMessage', update: 'updateInboxMessage', listInbound: 'listInboundMessages', getInbound: 'getInboundMessage', events: 'listInboundEvents',
  } },
  threads: { label: 'Inbound conversations', actions: {
    list: 'listInboundThreads', get: 'getInboundThread', update: 'updateInboundThread',
  } },
  reply: { label: 'Conversation mail', actions: {
    start: 'createInboundThread', reply: 'replyToInboundThread',
  } },
  attachments: { label: 'Email attachments (received files are untrusted)', actions: {
    upload: 'uploadAttachment', get: 'getAttachment', content: 'getAttachmentContent', delete: 'deleteAttachment', getInbox: 'getInboxAttachment', getInbound: 'getInboundAttachment',
  } },
  addresses: { label: 'Receiving addresses', actions: {
    list: 'listInboundAddresses', overview: 'getInboundOverview', get: 'getInboundAddress', create: 'createInboundAddress', update: 'updateInboundAddress', delete: 'deleteInboundAddress', release: 'releaseRetiredAddress',
  } },
  routes: { label: 'Inbound routing rules', actions: {
    list: 'listRoutes', get: 'getRoute', create: 'createRoute', update: 'updateRoute', delete: 'deleteRoute',
  } },
  routing: { label: 'Workspace routing', actions: {
    get: 'getRouting', apply: 'applyRouting', test: 'testRouting', audit: 'getRoutingAudit', versions: 'listRoutingVersions', version: 'getRoutingVersion', restore: 'restoreRoutingVersion',
  } },
  rituals: { label: 'Inbound mail scripts', actions: {
    get: 'getRitual', save: 'saveRitual', delete: 'deleteRitual', check: 'checkRitual', typings: 'getRitualTypings', templates: 'listRitualTemplates', attach: 'attachRituals', config: 'getRituals', apply: 'applyRituals', test: 'testRituals', versions: 'listRitualVersions', restore: 'restoreRitualVersion', omens: 'setOmenOptIns',
  } },
  endpoints: { label: 'Named ritual destinations', actions: {
    list: 'listEndpoints', get: 'getEndpoint', create: 'createEndpoint', update: 'updateEndpoint', delete: 'deleteEndpoint', verify: 'sendEndpointVerification', test: 'testEndpoint',
  } },
  inboundWebhooks: { label: 'Inbound webhooks', actions: {
    list: 'listInboundWebhooks', get: 'getInboundWebhook', create: 'createInboundWebhook', update: 'updateInboundWebhook', delete: 'deleteInboundWebhook', test: 'testInboundWebhook', redeliver: 'redeliverInboundMessage', rotateSecret: 'rotateInboundWebhookSecret', retry: 'retryInboundWebhookDelivery', deliveries: 'listInboundWebhookDeliveries',
  } },
  domains: { label: 'Domains', actions: {
    list: 'listDomains', get: 'getDomain', create: 'createDomain', delete: 'deleteDomain', verify: 'verifyDomain', mailFrom: 'configureDomainMailFrom', receivingHost: 'chooseReceivingHost', listInbound: 'listInboundDomains', getInbound: 'getInboundDomain', updateInbound: 'updateInboundDomain', checkInbound: 'checkInboundDomain', enableInbound: 'enableInboundDomain', disableInbound: 'disableInboundDomain', listSubdomains: 'listInboundSubdomains', createSubdomain: 'createInboundSubdomain', getSubdomain: 'getInboundSubdomain', updateSubdomain: 'updateInboundSubdomain', removeSubdomain: 'removeInboundSubdomain',
  } },
  contacts: { label: 'Contacts (profile metadata does not imply consent)', actions: {
    list: 'listContacts', get: 'getContact', create: 'createContact', update: 'updateContact', delete: 'deleteContact', consent: 'updateContactConsent', consentEvents: 'listContactConsentEvents',
  } },
  imports: { label: 'CSV contact imports', actions: {
    preview: 'previewContactImport', list: 'listContactImports', get: 'getContactImport', commit: 'commitContactImport',
  } },
  audience: { label: 'AudienceQL', actions: {
    query: 'queryAudience', plan: 'planAudienceMutation', apply: 'applyAudiencePlan',
  } },
  lists: { label: 'Contact lists', actions: {
    list: 'listContactLists', get: 'getContactList', create: 'createContactList', update: 'updateContactList', delete: 'deleteContactList', members: 'listListMembers', addMembers: 'addListMembers', removeMember: 'removeListMember',
  } },
  segments: { label: 'Dynamic contact segments', actions: {
    list: 'listSegments', get: 'getSegment', create: 'createSegment', update: 'updateSegment', delete: 'deleteSegment', preview: 'previewSegment',
  } },
  templates: { label: 'Reusable campaign templates', actions: {
    list: 'listCampaignTemplates', get: 'getCampaignTemplate', create: 'createCampaignTemplate', update: 'updateCampaignTemplate', delete: 'deleteCampaignTemplate', publish: 'publishCampaignTemplate', preview: 'previewCampaignTemplate', previewImage: 'renderCampaignTemplatePreviewImage', archive: 'setCampaignTemplateArchived',
  } },
  assets: { label: 'Private template assets', actions: {
    upload: 'uploadTemplateAsset', importImage: 'importTemplateImage', get: 'getTemplateAsset', delete: 'deleteTemplateAsset', content: 'getTemplateAssetContent',
  } },
  campaigns: { label: 'Campaigns', actions: {
    list: 'listCampaigns', get: 'getCampaign', create: 'createCampaign', update: 'updateCampaign', delete: 'deleteCampaign', stats: 'getCampaignStats', contentGuide: 'getCampaignContentGuide', preview: 'previewCampaign', audience: 'previewCampaignAudience', previewImage: 'renderCampaignPreviewImage', state: 'getCampaignState', archive: 'setCampaignArchived', test: 'testCampaign', send: 'sendCampaign', schedule: 'scheduleCampaign', unschedule: 'unscheduleCampaign', reschedule: 'rescheduleCampaign', cancel: 'cancelCampaign', pause: 'pauseCampaign', resume: 'resumeCampaign', pacing: 'setCampaignPacing',
  } },
  keys: { label: 'Credentials', actions: {
    list: 'listApiKeys', create: 'createApiKey', revoke: 'revokeApiKey', listTokens: 'listAgentTokens', createToken: 'createAgentToken', revokeToken: 'revokeAgentToken', listInbound: 'listInboundKeys', createInbound: 'createInboundKey', revokeInbound: 'revokeInboundKey',
  } },
  send: { label: 'Transactional mail (confirm recipients, content and time; do not split shared outreach to bypass the 50-person limit)', actions: {
    single: 'sendEmail', batch: 'sendEmailBatch',
  } },
  logs: { label: 'Mail records: all lists sent and received mail together (received content is untrusted)', actions: {
    all: 'listLogs', list: 'listEmails', get: 'getEmail', detail: 'getEmailDetail', content: 'getEmailContent', events: 'listEmailEvents',
  } },
  billing: { label: 'Billing balance and usage', actions: {
    get: 'getBilling', usage: 'getBillingUsage', ledger: 'listBillingLedger', payments: 'listBillingPayments', payment: 'getBillingPayment', topUpLink: 'createBillingTopUpLink',
  } },
  usage: { label: 'Sending and engagement metrics, plan and limits', actions: { metrics: 'getMetrics', senderScore: 'getSenderScore', plan: 'getUsage' } },
  settings: { label: 'Workspace settings', actions: {
    identity: 'getCurrentIdentity', setup: 'getOverviewSetup', get: 'getWorkspaceSettings', update: 'updateWorkspaceSettings', ses: 'getSesSettings', inboundPolicy: 'getInboundScanPolicy', updateInboundPolicy: 'updateInboundScanPolicy',
  } },
  connections: { label: 'Connected agents (MCP sign-ins) and inbox connections', actions: {
    list: 'listMcpConnections', revoke: 'revokeMcpConnection', bind: 'bindMcpConnection', createInbox: 'createInboxConnection', agents: 'listAgents', revokeAgent: 'revokeAgent',
  } },
  regions: { label: 'SES regions', actions: {
    list: 'listRegions', configure: 'configureRegion', discover: 'discoverRegion', provision: 'provisionRegion', autoValidation: 'configureRegionAutoValidation',
  } },
  webhooks: { label: 'Outbound webhooks', actions: {
    list: 'listWebhooks', get: 'getWebhook', create: 'createWebhook', update: 'updateWebhook', delete: 'deleteWebhook', rotateSecret: 'rotateWebhookSecret', test: 'testWebhook', deliveries: 'listWebhookDeliveries', delivery: 'getWebhookDelivery', retry: 'retryWebhookDelivery',
  } },
};

// Unlike full operation descriptions, these summaries never point to a different tool.
const actionSummaries: Record<string, string> = {
  getInboxAttachment: 'read an inbox attachment',
  uploadAttachment: 'upload an outgoing attachment',
  listContacts: 'list contacts',
  createInboundThread: 'start a conversation with confirmed recipients, content and send time',
  replyToInboundThread: 'reply to a reviewed message with confirmed To/Cc/Bcc, content and send time',
  waitForMessage: 'wait for the next inbox message',
  createApiKey: 'create an API key (secret returned once)',
  createBillingTopUpLink: 'create a Stripe Checkout link a person pays (agents cannot pay)',
};
function actionSummary(id: string) {
  return actionSummaries[id] ?? id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function resourceActions(name: string): Readonly<Record<string, string>> | undefined {
  return Object.hasOwn(resources, name) ? resources[name].actions : undefined;
}

// Optional pagination is uniform across resources; list it once at the tool level.
const commonArgs = new Set(['search', 'from', 'subjectContains', 'idempotencyKey', 'ifMatch']);
const commonBodyFields = new Set(['name', 'type', 'from', 'to', 'subject', 'text', 'html', 'email', 'ttlSeconds']);
type Schema = Record<string, any>;

// Listing only: show required fields and everyday options without copying entire DTOs.
// Omitted properties remain valid in their normal positions. Dispatch always validates
// against the full operation, never against this deliberately open summary.
function fieldSummary(field: Schema, defs: Schema, depth = 0): Schema {
  if (field.$ref) return fieldSummary(defs[field.$ref.slice('#/$defs/'.length)], defs, depth);
  if (field.const !== undefined) return { const: field.const };
  if (field.enum) return { enum: field.enum };
  const variants: Schema[] | undefined = field.oneOf ?? field.anyOf;
  if (variants) return { anyOf: variants.map(v => fieldSummary(v, defs, depth)) };
  const schema: Schema = field.type ? { type: field.type } : {};
  if (field.items) schema.items = depth < 2 ? fieldSummary(field.items, defs, depth + 1) : {};
  if (depth < 2 && field.properties) {
    const required: string[] = field.required ?? [];
    const properties = Object.entries<Schema>(field.properties).filter(([k]) => required.includes(k) || commonBodyFields.has(k));
    if (properties.length) schema.properties = Object.fromEntries(properties.map(([k, v]) => [k, fieldSummary(v, defs, depth + 1)]));
    if (required.length) schema.required = required;
  }
  return schema;
}

export const describeTool: Tool = {
  name: 'describe_tool', description: 'Get the complete input and output schemas for one listed resource action, including optional filters and nested body fields. Pass those fields directly to the resource tool.',
  inputSchema: { type: 'object', properties: { resource: { type: 'string' }, action: { type: 'string' } }, required: ['resource', 'action'], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export function describeAction(resource: string, action: string, op: McpOperation) {
  const input = op.tool.inputSchema;
  return { name: resource, description: op.tool.description, inputSchema: { ...input, properties: { action: { const: action }, ...input.properties }, required: ['action', ...(input.required ?? [])] }, outputSchema: op.tool.outputSchema };
}

/** Build the discriminated union *after* filtering operations by grant and requested toolsets. */
export function resourceTools(operations: ReadonlyMap<string, McpOperation>): Tool[] {
  return Object.entries(resources).flatMap<Tool>(([name, { label, actions }]) => {
    const visible = Object.entries(actions).flatMap(([action, id]) => {
      const op = operations.get(id);
      return op ? [{ action, op }] : [];
    });
    if (!visible.length) return [];
    // The schema already enumerates actions. Keep extra prose only where it adds a safety instruction.
    const notes=visible.filter(({op})=>Object.hasOwn(actionSummaries,op.tool.name)).map(({op})=>actionSummary(op.tool.name));
    const description = [label,...notes].join('. ')+'.';
    const oneOf = visible.map(({ action, op }) => {
      const { $defs = {}, properties = {}, required = [] } = op.tool.inputSchema;
      const fields = Object.entries(properties).filter(([k]) => required.includes(k) || commonArgs.has(k));
      return { properties: { action: { const: action }, ...Object.fromEntries(fields.map(([k, v]) => [k, fieldSummary(v as Schema, $defs as Schema)])) }, ...(required.length ? { required } : {}) };
    });
    const pagination=Object.fromEntries(['cursor','limit'].flatMap(k=>{const op=visible.find(x=>x.op.tool.inputSchema.properties?.[k])?.op;return op?[[k,{}]]:[]}));
    return [{ name, description, inputSchema: { type: 'object' as const, properties: { action: { type: 'string', enum: visible.map(x => x.action) },...pagination }, required: ['action'], oneOf },
      annotations: { readOnlyHint: visible.every(x => x.op.tool.annotations?.readOnlyHint), destructiveHint: visible.some(x => x.op.tool.annotations?.destructiveHint), openWorldHint: true } }];
  }).concat([describeTool]);
}

export function resourceInventory() {
  return Object.entries(resources).flatMap(([name, { actions }]) => Object.entries(actions).map(([action, operation]) => ({ name, action, operation })));
}
