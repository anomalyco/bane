/** Byte offsets into immutable, Bcc-scrubbed wire mail (not PostalMime's decoded text).
 * No body strings in the index. Delimiters match whole lines; depth, nodes and header
 * sizes are bounded. A truncated/unindexable object can still be read as raw MIME. */
export type MimePart = {offset:number;length:number;headerLength:number;type:string;encoding:string;charset?:string;filename?:string;parts?:MimePart[]};
export function mimeIndex(raw:Uint8Array):MimePart|null {
 const bytes=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength);let nodes=0;
 const param=(field:string,key:string)=>{
  for(const match of field.matchAll(/;\s*([\w*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g))if(match[1]!.toLowerCase()===key)return (match[2]?.replace(/\\(.)/g,'$1')??match[3])?.slice(0,255);
 };
 const part=(start:number,end:number,depth:number,fallback:string):MimePart|null=>{
  if(++nodes>200||depth>16)return null;
  const h=bytes.subarray(start,Math.min(end,start+65536));let body=start;
  while(body-start<h.length){const nl=h.indexOf(10,body-start);if(nl<0)return null;const blank=nl===body-start||nl===body-start+1&&bytes[body]===13;body=start+nl+1;if(blank)break;}
  if(body-start>=65536)return null;
  const fields=new Map<string,string>();for(const line of h.toString('latin1',0,body-start).replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/)){const pos=line.indexOf(':');if(pos>0)fields.set(line.slice(0,pos).toLowerCase(),line.slice(pos+1).trim());}
  const ct=fields.get('content-type')??fallback,type=ct.split(';',1)[0]!.trim().toLowerCase();
  const result:MimePart={offset:start,length:end-start,headerLength:body-start,type,encoding:(fields.get('content-transfer-encoding')??'7bit').toLowerCase(),charset:param(ct,'charset'),filename:param(fields.get('content-disposition')??'','filename')??param(ct,'name')};
  const boundary=param(ct,'boundary');
  if(type.startsWith('multipart/')&&boundary){
   const delimiter=Buffer.from('--'+boundary,'latin1');result.parts=[];let from=-1;
   for(let i=body;i<end;){const nl=bytes.subarray(i,end).indexOf(10),next=nl<0?end:i+nl+1;
    if(bytes[i]===45&&bytes.subarray(i,i+delimiter.length).equals(delimiter)){
     let j=i+delimiter.length;const last=bytes[j]===45&&bytes[j+1]===45;if(last)j+=2;
     while(j<next&&(bytes[j]===32||bytes[j]===9))j++;
     if(j===end||bytes[j]===10||bytes[j]===13&&bytes[j+1]===10){
      if(from>=0){let until=i;if(until>from&&bytes[until-1]===10)until--;if(until>from&&bytes[until-1]===13)until--;
       const child=part(from,until,depth+1,type==='multipart/digest'?'message/rfc822':'text/plain');if(!child)return null;result.parts.push(child);}
      from=next;if(last)return result;
     }
    }i=next;
   }return null;
  }
  if(type==='message/rfc822'&&['7bit','8bit','binary'].includes(result.encoding)){const child=part(body,end,depth+1,'text/plain');if(!child)return null;result.parts=[child];}
  return result;
 };return part(0,bytes.length,0,'text/plain');
}
