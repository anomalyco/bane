import type { ReceivingIssue } from '../../data/types.js'

const titles: Record<ReceivingIssue['code'], (host: string) => string> = {
  cname: host => `Can’t receive at ${host}`, foreign_mx: host => `Move mail for ${host}?`, split: host => `Mail for ${host} may be split`,
  wildcard: host => `A wildcard record answers for ${host}`, bane_record: host => `${host} is one of Bane’s own records`, host_taken: host => `${host} is already in use`, claimed: host => `${host} belongs to another workspace`, delegated: host => `${host} is a separate zone`,
  mx_missing: host => `The MX record on ${host} is gone`, wrong_region: host => `${host} points to another SES region`, null_mx: host => `${host} refuses all mail`,
  proof_stale: host => `Recheck ownership of ${host}`, identity_stale: host => `Recheck the SES identity for ${host}`,
}

// The same issue in a few words, for a table cell beside its host.
const reasons: Record<ReceivingIssue['code'], string> = {
  cname: 'CNAME in the way', foreign_mx: 'MX points elsewhere', split: 'MX split', wildcard: 'Wildcard record', bane_record: 'Bane’s own record', host_taken: 'Host in use', claimed: 'Another workspace’s', delegated: 'Separate zone',
  mx_missing: 'MX record gone', wrong_region: 'Wrong SES region', null_mx: 'Refuses all mail', proof_stale: 'Recheck ownership', identity_stale: 'Recheck SES identity',
}

export function receivingIssueReason(code: string) {
  return Object.hasOwn(reasons, code) ? reasons[code as ReceivingIssue['code']] : 'Needs attention'
}

export function receivingIssueTitle(code: string, host: string) {
  return Object.hasOwn(titles, code) ? titles[code as ReceivingIssue['code']](host) : `Receiving at ${host} needs attention`
}
