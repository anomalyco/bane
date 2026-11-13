import { z } from '@hono/zod-openapi';
import { AttachmentContentType, AttachmentFilename, mailAddress, senderDisplayName } from './outbound-content.js';
import { GRADES } from './standing-model.js';

// Use Bane's bare address + fromName form or a single display mailbox, never an address list.
export function splitMailbox(from: string) {
  const display = /^([^<>]*)<([^<>]+)>$/.exec(from.trim());
  return { address: (display?.[2] ?? from).trim(), name: display?.[1]?.trim().replace(/^"(.*)"$/, '$1') };
}
const address = mailAddress();
const headers = z.record(z.string().min(1).max(76).regex(/^[a-z0-9-]+$/i), z.string().max(998).regex(/^[^\r\n\0]*$/)).refine(v => {
  const names = Object.keys(v); return names.length <= 50 && new Set(names.map(n => n.toLowerCase())).size === names.length;
}, 'At most 50 distinct case-insensitive header names.');
export const DraftCheck = z.object({
  from: z.string().min(1).max(460).refine(v => { const m = splitMailbox(v); return address.safeParse(m.address).success && (!m.name || senderDisplayName().safeParse(m.name).success); }, 'Use a single From mailbox.'),
  fromName: senderDisplayName().optional(), to: z.union([address, z.array(address).max(50)]).optional(), subject: z.string().max(998),
  html: z.string().max(512 * 1024).optional(), text: z.string().max(512 * 1024).optional(), stream: z.enum(['transactional','marketing']),
  headers: headers.optional().describe('Header name to value. May include observed or planned transport headers; not trusted as authentication evidence.'),
  attachments: z.array(z.object({filename: AttachmentFilename, contentType: AttachmentContentType, size: z.int().min(0).max(40 * 1024 * 1024)}).strict()).max(50).optional().describe('Optional metadata only: decoded byte size, never attachment bytes or fetch URLs.'),
}).strict().refine(d => !!(d.html?.trim() || d.text?.trim()), 'Supply HTML or text.').openapi('SendabilityDraft');
export const CheckInput = z.union([DraftCheck, z.object({emailId: z.string().min(1).max(160)}).strict(), z.object({campaignId: z.string().min(1).max(160)}).strict()]).openapi('EmailCheckInput');
export const categories = ['authentication','content','headers','size','rendering','reputation'] as const;
const percent = z.int().min(0).max(100);
export const CheckResult = z.object({score: percent, grade: z.enum(GRADES), categories: z.array(z.object({id: z.enum(categories), score: percent, weight: percent})),
  findings: z.array(z.object({ruleId: z.string(), category: z.enum(categories), severity: z.enum(['info','warning','error']), title: z.string(), detail: z.string(), fix: z.string(), evidence: z.record(z.string(),z.union([z.number(),z.string()])).optional()})),
}).openapi('EmailCheckResult');
export type CheckReport = z.infer<typeof CheckResult>;
export type CheckMail = z.infer<typeof DraftCheck> & { recipientCount?: number; generatedUnsubscribe?: boolean; previewText?: string; tracking?: boolean };
