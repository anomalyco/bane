import type { ReceivingIssue } from '../../data/types.js'

const titles: Record<ReceivingIssue['code'], (host: string) => string> = {
  cname: host => `Can’t receive at ${host}`, foreign_mx: host => `Move mail for ${host}?`, split: host => `Mail for ${host} may be split`,
  wildcard: host => `A wildcard record answers for ${host}`, bane_record: host => `${host} is one of Bane’s own records`, host_taken: host => `${host} is already in use`, claimed: host => `${host} belongs to another workspace`, delegated: host => `${host} is a separate zone`,
  mx_missing: host => `The MX record on ${host} is gone`, wrong_region: host => `${host} points to another SES region`, null_mx: host => `${host} refuses all mail`,
  proof_stale: host => `Recheck ownership of ${host}`, identity_stale: host => `Recheck the SES identity for ${host}`,
}

export function receivingIssueTitle(code: string, host: string) {
  return Object.hasOwn(titles, code) ? titles[code as ReceivingIssue['code']](host) : `Receiving at ${host} needs attention`
}
