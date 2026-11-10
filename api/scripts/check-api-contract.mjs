// Compare the public wire contract, not generated prose/examples or component names.
// No installs or network access required. Only resolve local JSON Pointers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const methods = ['get','head','post','put','patch','delete','options','trace'];
const keys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
const stable = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const equal = (a,b) => stable(a) === stable(b);
const security = rules => (rules ?? []).map(rule => stable(Object.fromEntries(Object.entries(rule).map(([k,v]) => [k,[...v].sort()])))).sort();
function resolve(doc, node) {
  const seen = new Set();
  while (node?.$ref) {
    const ref = node.$ref;
    assert(ref.startsWith('#/') && !seen.has(ref), `Unsupported or cyclic reference ${ref}`);
    seen.add(ref);
    const target = ref.slice(2).split('/').reduce((x,k) => x?.[decodeURIComponent(k).replaceAll('~1','/').replaceAll('~0','~')],doc);
    assert.notEqual(target, undefined, `Missing reference ${ref}`);
    // OpenAPI 3.1 permits schema siblings. Fail closed on an ambiguous overlay.
    const siblings = Object.fromEntries(Object.entries(node).filter(([k]) => !['$ref','description','summary','title','example','examples','default','deprecated'].includes(k)));
    for (const k of Object.keys(siblings)) assert(!Object.hasOwn(target,k) || equal(target[k], siblings[k]), `Overlapping ${k} beside ${ref}: review contract checker`);
    node = Object.keys(siblings).length ? {...target, ...siblings} : target;
  }
  return node;
}

function compare(base, head) {
  assert(base.paths && head.paths, 'Expected two OpenAPI documents');
  const changes = [], add = (breaking, where, detail) => changes.push({breaking, message:`${where}: ${detail}`});
  const empty = {};
  // Generated object inheritance uses allOf. Compare the effective public fields
  // rather than treating a switch between inline and inherited fields as removal.
  function intersection(doc, parts) {
    const out = Object.create(null);
    for (const part of parts) {
      const s = resolve(doc,part);
      if (typeof s !== 'object') return null;
      for (const [k,v] of Object.entries(s)) {
        if (['title','description','example','examples','default','deprecated'].includes(k)) continue;
        if (k === 'properties') {
          out.properties ??= Object.create(null);
          for (const [p,shape] of Object.entries(v)) {
            if (Object.hasOwn(out.properties,p) && !equal(out.properties[p],shape)) return null;
            out.properties[p] = shape;
          }
        } else if (k === 'required') out.required = [...new Set([...(out.required ?? []),...v])];
        else if (k === 'allOf' || (Object.hasOwn(out,k) && !equal(out[k],v))) return null;
        else out[k]=v;
      }
    }
    return out;
  }
  function flatten(doc,s) {
    if (!s?.allOf) return s;
    const {allOf,...own}=s;
    return intersection(doc,[own,...allOf]) ?? s;
  }
  function schemas(old, next, at, req, ancestors = []) {
    const left = resolve(base, old ?? empty), right = resolve(head, next ?? empty);
    if (ancestors.some(([x,y]) => left === x && right === y)) return;
    const recur = (x,y,p) => schemas(x,y,p,req,[...ancestors,[left,right]]);
    const a = flatten(base,left), b = flatten(head,right);
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (a !== b) add(req ? a !== false && b !== true : b !== false && a !== true,at,'boolean schema changed');
      return;
    }
    if (a.anyOf || b.anyOf) {
      const alternatives = (doc,s) => {
        if (!s.anyOf) return [s];
        const {anyOf,...own}=s;
        return anyOf.map(v=>Object.keys(own).length ? intersection(doc,[own,v]) ?? {allOf:[own,v]} : v);
      };
      const aa=alternatives(base,a), bb=alternatives(head,b);
      // Every old input variant must still be accepted; every new output variant
      // must still be consumable. Try structural matches, even for same-type objects.
      const [needed,candidates]=req ? [aa,bb] : [bb,aa];
      for (const [i,variant] of needed.entries()) {
        const trials=candidates.map(candidate=>{
          const start=changes.length;
          recur(req?variant:candidate,req?candidate:variant,`${at}.anyOf[${i}]`);
          return changes.splice(start);
        });
        const count=xs=>xs.filter(x=>x.breaking).length;
        trials.sort((x,y)=>count(x)-count(y) || x.length-y.length);
        if (!trials.length) add(true,at,'no compatible anyOf alternative');
        else changes.push(...trials[0]);
      }
      if (aa.length !== bb.length) add(false,at,`anyOf alternatives ${aa.length} → ${bb.length}`);
      return;
    }
    const types = s => s.type ? [].concat(s.type, s.nullable ? ['null'] : []) : ['array','object','number','integer','string','null','boolean'];
    const [before, after] = [types(a),types(b)];
    if (!equal([...before].sort(), [...after].sort())) {
      const accepts = (set,t) => set.includes(t) || (t === 'integer' && set.includes('number'));
      add(req ? before.some(t => !accepts(after,t)) : after.some(t => !accepts(before,t)),at,`type ${before.join('|')} → ${after.join('|')}`);
    }
    const vals = n => n.enum ?? ('const' in n ? [n.const] : null);
    const va = vals(a), vb = vals(b);
    if (!equal(va?.map(stable).sort(),vb?.map(stable).sort())) {
      const [values,allowed] = req ? [va,vb] : [vb,va];
      add(!!allowed && (!values || values.some(x=>!allowed.some(y=>equal(x,y)))),at,`enum ${stable(va)} → ${stable(vb)}`);
    }
    for (const name of new Set([...(a.required ?? []), ...(b.required ?? [])])) {
      const was = !!a.required?.includes(name), now = !!b.required?.includes(name);
      if (was !== now) add(req ? now : !now,`${at}.${name}`,now ? 'became required' : 'became optional');
    }
    for (const name of keys(a.properties,b.properties)) {
      const path = `${at}.${name}`;
      if (!Object.hasOwn(b.properties ?? {},name)) add(true,path,'field removed');
      else if (!Object.hasOwn(a.properties ?? {},name)) add(false,path,'field added');
      else recur(a.properties[name],b.properties[name],path);
    }
    if (a.items !== undefined || b.items !== undefined) recur(a.items,b.items,`${at}[]`);
    if (a.additionalProperties !== undefined || b.additionalProperties !== undefined) recur(a.additionalProperties ?? true,b.additionalProperties ?? true,`${at}.*`);
    for (const key of ['minimum','maximum','minLength','maxLength','minItems','maxItems','minProperties','maxProperties','exclusiveMinimum','exclusiveMaximum','pattern','format','multipleOf','uniqueItems']) {
      if (!equal(a[key],b[key])) {
        const lower = /^(min|exclusiveMin)/.test(key), upper = /^(max|exclusiveMax)/.test(key);
        const tighter = b[key] !== undefined && (a[key] === undefined || (lower ? b[key]>a[key] : upper ? b[key]<a[key] : true));
        add(req && tighter,at,`${key} ${stable(a[key])} → ${stable(b[key])}`);
      }
    }
    // Compare branches as schemas (including their referenced components), not just $ref text.
    // A structural rewrite with no uniquely comparable branch is flagged for review.
    for (const key of ['oneOf','allOf']) {
      const aa = a[key] ?? [], bb = [...(b[key] ?? [])];
      for (const [i,x] of aa.entries()) {
        let j = bb.findIndex(y => equal(x,y));
        if (j < 0) j = bb.findIndex(y => equal(resolve(base,x)?.type,resolve(head,y)?.type));
        if (j < 0) add(key !== 'allOf' || !req,at,`${key} branch removed`);
        else recur(x,bb.splice(j,1)[0],`${at}.${key}[${i}]`);
      }
      if (bb.length) add(key === 'allOf' || key === 'oneOf' || !aa.length || !req,at,`${key} branch added`);
    }
  }
  function content(a,b,at,req) {
    for (const media of keys(a,b)) {
      if (!b?.[media]) add(true,at,`removed media type ${media}`);
      else if (!a?.[media]) add(false,at,`added media type ${media}`);
      else schemas(a[media].schema,b[media].schema,`${at} ${media}`,req);
    }
  }
  function params(doc,path,op) {
    return Object.fromEntries([...(path.parameters ?? []),...(op.parameters ?? [])].map(x => {
      const p = resolve(doc,x); return [`${p.in} ${p.in === 'header' ? p.name.toLowerCase() : p.name}`,p];
    }));
  }
  for (const path of keys(base.paths,head.paths)) {
    const a = resolve(base,base.paths[path]), b = resolve(head,head.paths[path]);
    if (!a || !b) { add(!b,path,b?'path added':'path removed'); continue; }
    for (const method of methods) {
      const x = a[method], y = b[method], at = `${method.toUpperCase()} ${path}`;
      if (!x || !y) { if (x || y) add(!y,at,y?'operation added':'operation removed'); continue; }
      const start = changes.length;
      if (x.operationId !== y.operationId) add(true,at,`operationId ${x.operationId} → ${y.operationId}`);
      if (!equal(security(x.security ?? base.security),security(y.security ?? head.security))) add(true,at,'security requirements changed');
      const pa = params(base,a,x), pb = params(head,b,y);
      for (const name of keys(pa,pb)) {
        const o = pa[name], n = pb[name], p = `${at} ${name}`;
        if (!n) add(true,p,'parameter removed');
        else if (!o) add(!!n.required,p,`${n.required?'required':'optional'} parameter added`);
        else {
          if (!!o.required !== !!n.required) add(!!n.required,p,n.required?'became required':'became optional');
          schemas(o.schema,n.schema,p,true); content(o.content,n.content,p,true);
        }
      }
      const bodyA = resolve(base,x.requestBody), bodyB = resolve(head,y.requestBody);
      if (!bodyA?.required && bodyB?.required) add(true,at,'request body became required');
      content(bodyA?.content,bodyB?.content,`${at} request`,true);
      for (const status of keys(x.responses,y.responses)) {
        const o = resolve(base,x.responses[status]), n = resolve(head,y.responses[status]), p = `${at} ${status}`;
        if (!o || !n) { add(!n && /^2/.test(status),p,n?'response added':'response removed'); continue; }
        const headers = r => Object.fromEntries(Object.entries(r.headers ?? {}).map(([k,v]) => [k.toLowerCase(),v]));
        const ha = headers(o), hb = headers(n);
        for (const h of keys(ha,hb)) {
          if (!ha[h] || !hb[h]) add(!hb[h],p,`header ${h} ${hb[h]?'added':'removed'}`);
          else schemas(resolve(base,ha[h]).schema,resolve(head,hb[h]).schema,`${p} header ${h}`,false);
        }
        content(o.content,n.content,p,false);
      }
      if (changes.length === start && !equal(x,y)) add(false,at,'operation metadata or equivalent schema changed');
    }
  }
  for (const k of keys(base.components?.securitySchemes,head.components?.securitySchemes)) {
    const a=base.components?.securitySchemes?.[k], b=head.components?.securitySchemes?.[k];
    const wire = x => x && Object.fromEntries(Object.entries(x).filter(([key]) => key !== 'description'));
    if (!equal(wire(a),wire(b))) add(!!a,`security scheme ${k}`,a ? 'changed or removed' : 'added');
  }
  return changes;
}

function selfTest() {
  const s = {type:'object',properties:{state:{enum:['a','b']}}};
  const json = {content:{'application/json':{schema:{$ref:'#/components/schemas/Item'}}}};
  const base = {paths:{'/x':{post:{operationId:'create',requestBody:json,responses:{201:{...json,headers:{ETag:{schema:{type:'string'}}}}}}}},components:{schemas:{Item:s}}};
  assert.deepEqual(compare(base,structuredClone(base)),[]);
  for (const mutate of [d=>delete d.paths['/x'],d=>delete d.paths['/x'].post,d=>d.paths['/x'].post.operationId='new',d=>d.components.schemas.Item.required=['state'],d=>delete d.components.schemas.Item.properties.state,d=>d.components.schemas.Item.properties.state.enum.pop(),d=>delete d.paths['/x'].post.responses[201],d=>delete d.paths['/x'].post.responses[201].headers.ETag,d=>d.paths['/x'].post.security=[{apiKey:[]}],d=>d.paths['/x'].parameters=[{name:'limit',in:'query',required:true,schema:{type:'integer'}}]]) {
    const d = structuredClone(base); mutate(d); assert(compare(base,d).some(x=>x.breaking),String(mutate));
  }
  const more = structuredClone(base); more.components.schemas.Item.properties.note={type:'string'};
  assert(compare(base,more).every(x=>!x.breaking));
  const string={type:'string'}, num={type:'number'}, nil={type:'null'};
  const choice=(...values)=>({...string,enum:values}), union=(...anyOf)=>({anyOf}), object=(properties)=>({type:'object',properties});
  const doc=(schema,req)=>{
    const content={'application/json':{schema}};
    return {paths:{'/probe':{post:{operationId:'probe',...(req?{requestBody:{content}}:{}),responses:{200:req?{}:{content}}}}}};
  };
  const check=(req,old,next,breaking,why)=>assert.equal(compare(doc(old,req),doc(next,req)).some(x=>x.breaking),breaking,why);
  check(true,object({note:string}),object({}),true,'removed request field in an open object');
  for (const [req,old,next,breaking] of [
    [true,choice('a','b'),choice('a'),true],[true,string,choice('a'),true],
    [true,choice('a'),choice('a','b'),false],[true,choice('a'),string,false],
    [false,choice('a'),choice('a','b'),true],[false,choice('a'),string,true],
    [false,choice('a','b'),choice('a'),false],[false,string,choice('a'),false],
    [true,string,union(num,string),false],[true,union(num,string),string,true],
    [false,union(nil,string),string,false],[false,string,union(nil,string),true],
    [false,object({}),{...object({}),additionalProperties:false},false],
    [true,object({}),{...object({}),additionalProperties:false},true],
    [false,object({a:string}),{allOf:[object({a:string}),object({b:num})]},false],
    [false,{allOf:[object({a:string}),object({b:num})]},object({a:string}),true],
    [true,union(object({x:string}),object({y:num})),union(object({y:num,z:string}),object({x:string,z:string})),false],
    [false,union(object({x:string}),object({y:num})),union(object({y:num}),object({x:string})),false],
  ]) check(req,old,next,breaking,`${req?'request':'response'} ${stable(old)} → ${stable(next)}`);
  console.log('API compatibility self-test passed');
}
if (process.argv[2] === '--self-test') selfTest();
else {
  const [a,b,flag,...rest] = process.argv.slice(2);
  assert(a && b && (!flag || flag === '--allow-breaking') && !rest.length,'Usage: node check-api-contract.mjs BASE.json HEAD.json [--allow-breaking]');
  const changes = compare(...[a,b].map(p => JSON.parse(readFileSync(p,'utf8'))));
  for (const {breaking,message} of changes) console.log(`${breaking?'BREAKING':'compatible'}  ${message}`);
  const count = changes.filter(x=>x.breaking).length;
  console.log(`${count} breaking, ${changes.length-count} non-breaking changes${count && flag?' (api-breaking waiver)':''}`);
  if (count && !flag) process.exitCode = 1;
}
