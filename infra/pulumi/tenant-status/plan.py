#!/usr/bin/env python3
"""Read-only IAM and intake preflight. CI owns the real Pulumi preview."""
import argparse, json, os, shutil, subprocess, tempfile
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--plan', required=True, action='store_true')
p.add_argument('--stage', required=True, choices=('dev','production'))
stage = p.parse_args().stage
here = Path(__file__).resolve().parent
shared = here.parent.parent / 'aws-shared'
def run(*argv, cwd=here, env=None):
    return subprocess.check_output(argv, cwd=cwd, env=env, text=True).strip()

cfg = json.loads(run('bun','-e',"console.log(JSON.stringify(require(process.argv[1]).config))", str(here.parent/f'Pulumi.{stage}.yaml')))
account = cfg['bane:deployRoleArn'].split(':')[4]
profile = 'bane-'+stage
def aws(region,*args):
    return json.loads(run('aws','--profile',profile,'--region',region,'--no-cli-pager','--output','json',*args))
assert aws('us-east-2','sts','get-caller-identity')['Account']==account
actions = ['ses:UpdateReputationEntityCustomerManagedStatus','ses:GetReputationEntity']
origin = 'https://dev.bane.mx' if stage=='dev' else 'https://bane.mx'
def live(name):
    arn = f'arn:aws:iam::{account}:policy/{name}'
    vs = aws('us-east-1','iam','get-policy','--policy-arn',arn)['Policy']['DefaultVersionId']
    return aws('us-east-1','iam','get-policy-version','--policy-arn',arn,'--version-id',vs)['PolicyVersion']['Document']

print(f'## {stage} — proposed identity/default-policy changes (live IAM reads)')
identity=[]
for name in ['bane-runtime','bane-runtime-ohio','bane-runtime-trusted']:
    desired = json.loads(run('node',str(shared/'runtime-policies.mjs'),'--fresh',name,account,origin)); identity.append(desired)
    actual=live(name); stripped=json.loads(json.dumps(desired)); keep=[]
    for st in stripped['Statement']:
        if st.get('Action') in actions: continue
        if isinstance(st.get('Action'),list):
            st['Action']=[a for a in st['Action'] if a not in actions]
            if not st['Action']: continue
        keep.append(st)
    stripped['Statement']=keep
    if actual==desired: print(f'  = {name}')
    elif actual==stripped: print(f'  ~ {name}: add tenant status read/update only')
    else: raise SystemExit('Unexpected live drift in '+name+'; inspect privately before planning changes')
boundary=json.loads((shared/'runtime-boundary-policy.json').read_text().replace('YOUR_AWS_ACCOUNT_ID',account).replace('YOUR_STAGE_ORIGIN',origin))
print(f'  ~ boundary: after #76 only, allow tenant status read/update; size {len(json.dumps(boundary,separators=(",",":")))}/6144')
assert len(json.dumps(boundary,separators=(',',':')))<=6144

with tempfile.TemporaryDirectory(prefix='bane-tenant-plan-') as tmp:
    root=Path(tmp); os.umask(0o077)
    for region in ['us-east-2','us-east-1']:
        trusted=region=='us-east-1'
        if trusted and str(cfg['bane:trustedFeedbackPublish']).lower()!='true': continue
        topic='bane-trusted-feedback' if trusted else 'bane-feedback'; arn=f'arn:aws:sns:{region}:{account}:{topic}'
        routes=aws(region,'sns','list-subscriptions-by-topic','--topic-arn',arn)['Subscriptions']
        assert any(r['Protocol']=='https' and r['Endpoint']==origin+'/v1/events/ses' and r['SubscriptionArn'].startswith(arn+':') for r in routes), 'missing confirmed intake'
        prefix='bane-trusted-' if trusted else 'bane-probation-'; tenant='ws_'+'a'*32
        names=[(prefix+tenant,True),('unrelated-'+tenant,False)] + ([] if trusted else [('bane-'+tenant,True)])
        ctx={'aws:RequestedRegion':region,'aws:ResourceTag/bane:owner':'bane','aws:ResourceTag/bane:installation-id':'bane:pool','aws:ResourceTag/bane:purpose':'workspace-tenant'}
        for name,allowed in names:
            request={'PolicyInputList':[json.dumps(doc) for doc in identity], 'PermissionsBoundaryPolicyInputList':[json.dumps(boundary)],
                     'ActionNames':actions, 'ResourceArns':[f'arn:aws:ses:{region}:{account}:tenant/{name}/fixture'],
                     'ContextEntries':[{'ContextKeyName':k,'ContextKeyValues':[v],'ContextKeyType':'string'} for k,v in ctx.items()]}
            (root/'request.json').write_text(json.dumps(request))
            result=aws(region,'iam','simulate-custom-policy','--cli-input-json',f'file://{root}/request.json')['EvaluationResults']
            assert len(result)==len(actions) and all((x['EvalDecision']=='allowed')==allowed for x in result), 'unexpected simulation decision'
        print(f'  {region}: {topic} → confirmed HTTPS; proposed IAM simulations pass. CI verifies the operator-owned rule and target.')
