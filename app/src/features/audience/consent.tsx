// The API's contact states, in the order a marketer meets them, each with the one line that says what it means for a campaign.
export const statusOptions = [{ value: 'subscribed', label: 'Subscribed' }, { value: 'unknown', label: 'Unknown' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Suppressed' }]
export const consentHelp: Record<string, string> = {
  subscribed: 'Can receive campaigns.',
  unknown: 'No recorded consent, so campaigns skip them.',
  unsubscribed: 'Opted out, so campaigns skip them.',
  suppressed: 'Bounced, complained or was blocked, so it is never emailed.',
}
const legend: Record<string, string> = { subscribed: 'can receive campaigns', unknown: 'no recorded consent; campaigns skip them', unsubscribed: 'opted out', suppressed: 'bounced, complained or blocked; never emailed' }
export const consentTitle = (status: string) => `${statusOptions.find(option => option.value === status)?.label ?? status}: ${legend[status] ?? ''}`
export function ConsentLegend() {
  return <p className="audience-legend">{statusOptions.map(option => <span key={option.value}><span className="audience-legend__term">{option.label}</span> {legend[option.value]}</span>)}</p>
}
