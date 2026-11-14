// The AWS resource tags this service writes and checks. The keys (and the owner tag's value) stay bane:* for now: the
// IAM policies that gate tagging (infra/aws-shared runtime policies and the BYO CloudFormation templates) allow only
// those. Switch TAG_PREFIX together with those policies at the infra cutover. Checks already accept nightmail:* too, so
// a resource tagged either way stays ours. bane: remove after rename cleanup.
export const TAG_PREFIX = 'bane' as const;
type Tag = { Key?: string; Value?: string };
export const tagKey = (name: 'owner' | 'installation-id' | 'purpose' | 'domain-claim') => `${TAG_PREFIX}:${name}`;
export const ownerTag = { Key: tagKey('owner'), Value: TAG_PREFIX };
const name = (key: string | undefined) => key?.match(/^(?:nightmail|bane):(.+)$/)?.[1] ?? key;
const same = (have: Tag, want: Tag) => name(have.Key) === name(want.Key)
  && (have.Value === want.Value || name(want.Key) === 'owner' && ['nightmail', 'bane'].includes(have.Value ?? '') && ['nightmail', 'bane'].includes(want.Value ?? ''));
/** Whether a resource carries every wanted tag, under either prefix. */
export const hasTags = (have: Tag[] | undefined, want: Tag[]) => want.every(w => have?.some(h => same(h, w)) ?? false);
