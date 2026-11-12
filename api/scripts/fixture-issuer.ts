// Acceptance-only issuer. Each shard creates its own key and trusts its certificate.
import {createHash,createPrivateKey,createPublicKey,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {pathToFileURL} from 'node:url';

function fixture() {
  const issuer=new URL(process.env.ACCOUNT_ISSUER!);
  if(issuer.protocol!=='https:' || issuer.hostname!=='127.0.0.1')throw Error('A loopback fixture issuer is required');
  const key=createPrivateKey(readFileSync(process.env.BANE_TEST_SIGNING_KEY!));
  return {issuer:issuer.origin,key};
}
export function mintResourceToken(resource:string,subject:string,scope:string) {
  const {issuer,key}=fixture(), clientId='fixture-'+randomUUID(), jti=randomUUID(), now=Math.floor(Date.now()/1000);
  const parts=[{typ:'at+jwt',alg:'ES256',kid:'fixture'},{iss:issuer,aud:resource,sub:subject,client_id:clientId,jti,scope,iat:now,exp:now+300}];
  const body=parts.map(p=>Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
  const token=body+'.'+Buffer.from(sign('sha256',Buffer.from(body),{key,dsaEncoding:'ieee-p1363'})).toString('base64url');
  return {token,clientId,consentId:'at_'+createHash('sha256').update(JSON.stringify([issuer,clientId,subject,jti])).digest('hex')};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const {issuer,key}=fixture();
  const keys={keys:[{...createPublicKey(key).export({format:'jwk'}),kid:'fixture',alg:'ES256'}]};
  createServer({key:readFileSync(process.env.BANE_TEST_SIGNING_KEY!),cert:readFileSync(process.env.NODE_EXTRA_CA_CERTS!)},(req,res)=>{
    const data=req.url==='/jwks'?keys:req.url==='/.well-known/openid-configuration'?{issuer,jwks_uri:issuer+'/jwks'}:null;
    res.writeHead(data?200:404,{'content-type':'application/json'}).end(JSON.stringify(data));
  }).listen(Number(new URL(issuer).port),'127.0.0.1');
}
