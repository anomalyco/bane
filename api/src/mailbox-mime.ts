import type { S3Client } from '@aws-sdk/client-s3';
import type { MailObjects } from './mail-objects.js';
import { ApiError, lazyModule } from './core.js';

const loadS3Commands = lazyModule(() => import('@aws-sdk/client-s3'));

const MiB=1024*1024, PREFIX=2*MiB, FIRST_PART=5.25*MiB;
export const PARSE_LIMIT=6*MiB;

// AWS's receiving-email-notifications-examples shows the SES-added first Received field can end
// in "for recipient@example.com;". Remove that field (including folds) when not ours. The S3
// action preserves raw MIME, so also drop top-level Bcc/Resent-Bcc if physically present.
// Operate on byte offsets: never reserialize MIME, DKIM headers, attachments or the body.
function workspaceMime(bytes:Uint8Array,region:string,recipients:string[]) {
  const raw=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let pos=0,kept=0,seenReceived=false;
  let copy:Buffer|undefined,written=0;
  while(pos<raw.length) {
    const start=pos;
    let end=raw.indexOf(10,pos); if (end===pos || (end===pos+1 && raw[pos]===13)) break;
    const firstEnd=end<0?raw.length:end;
    pos=end<0?raw.length:end+1;
    while(raw[pos]===32 || raw[pos]===9) { end=raw.indexOf(10,pos); pos=end<0?raw.length:end+1; }
    const name=raw.toString('latin1',start,Math.min(firstEnd,start+12)).toLowerCase();
    const maybeBlind=name.startsWith('bcc') || name.startsWith('resent-bcc');
    let remove=maybeBlind && /^(?:bcc|resent-bcc)[ \t]*:/i.test(raw.toString('latin1',start,firstEnd));
    if (!seenReceived && name.startsWith('received:')) {
      seenReceived=true;
      const field=pos-start<=64*1024 ? raw.toString('latin1',start,pos).replace(/\r?\n[ \t]+/g,' ') : '';
      const match=/\bby\s+inbound-smtp\.([\w-]+)\.amazonaws\.com\b[^;]*?\sfor\s+([^;]+);/i.exec(field);
      remove=!field || (match?.[1]===region && !recipients.includes(match[2]!.trim().replace(/^<|>$/g,'').toLowerCase()));
    }
    if (remove) { copy??=Buffer.allocUnsafe(raw.length);written+=raw.copy(copy,written,kept,start);kept=pos; }
  }
  if (!copy) return bytes;
  return copy.subarray(0,written+raw.copy(copy,written,kept));
}

/** Inspect the exact bytes being copied. CopySourceIfMatch prevents substituting another object after inspection. */
export async function copyWorkspaceRaw(client:S3Client,region:string,bucket:string,source:string,key:string,recipients:string[],kind:'raw'|'legacy-raw'|'kept',etag?:string,reserve?:(bytes:number)=>Promise<void>,objects?:MailObjects) {
  const { HeadObjectCommand, GetObjectCommand, PutObjectCommand, CopyObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = await loadS3Commands();
  const location={Bucket:bucket,Key:source};
  const head=await client.send(new HeadObjectCommand(location));
  if (head.ContentLength === undefined || !head.ETag) throw new Error('Raw message metadata unavailable');
  if (etag && head.ETag!==etag) throw new ApiError(409,'MAILBOX_STAGING_CHANGED','The recovered message no longer matches the inspected object.');
  const size=head.ContentLength;
  if (size>40*MiB) throw new ApiError(413,'RAW_MESSAGE_TOO_LARGE','The raw message exceeds 40 MiB.');
  await reserve?.(size); // Before GET, copy, MIME or attachment work. Idempotent by receipt.
  // Pin the checked object and do not let fetch transparently expand BYO Content-Encoding metadata.
  const get=async(start:number,end:number,range:boolean)=>{
    const object=await client.send(new GetObjectCommand({...location,IfMatch:head.ETag,ResponseContentEncoding:'identity',Range:range?`bytes=${start}-${end-1}`:undefined}));
    if(range && object.ContentRange!==`bytes ${start}-${end-1}/${size}`) throw new Error('Expected a bounded S3 range response');
    const bytes=await object.Body!.transformToByteArray();if(bytes.length!==end-start)throw new Error('Incomplete S3 response');return bytes;
  };
  const large=size>PARSE_LIMIT;
  let original=await get(0,large?PREFIX:size,large);
  const hasEnd=(p:Uint8Array)=>{const b=Buffer.from(p.buffer,p.byteOffset,p.length);return b[0]===10 || b[0]===13 && b[1]===10 || b.includes('\n\n') || b.includes('\n\r\n');};
  const headerLimit=()=>new ApiError(422,'MAILBOX_RAW_HEADERS_TOO_LARGE','The raw headers exceed the bounded workspace scrub budget.');
  if(large && !hasEnd(original)){original=await get(0,FIRST_PART,true);if(!hasEnd(original))throw headerLimit();}
  const bytes=workspaceMime(original,region,recipients),removed=original.length-bytes.length;
  if(objects){
    if(!large) await objects.put(key,bytes,'message/rfc822');
    else {
      const start=original.length;
      const rest=await client.send(new GetObjectCommand({...location,IfMatch:head.ETag,Range:`bytes=${start}-${size-1}`,ResponseContentEncoding:'identity'}));
      if(!rest.Body || rest.ContentRange!==`bytes ${start}-${size-1}/${size}`)throw new Error('Incomplete S3 range');
      const reader=rest.Body.transformToWebStream().getReader();
      const stream=new ReadableStream<Uint8Array>({start:c=>c.enqueue(bytes),async pull(c){const part=await reader.read();if(part.done)c.close();else c.enqueue(part.value);},cancel:r=>reader.cancel(r)});
      await objects.put(key,{stream,length:size-removed},'message/rfc822');
    }
    return {bytes,sizeBytes:size-removed,large};
  }
  const destination={Bucket:bucket,Key:key,Tagging:`bane-kind=${kind}`};
  const copy={CopySource:`${bucket}/${source}`,CopySourceIfMatch:head.ETag};
  if(!removed) await client.send(new CopyObjectCommand({...destination,...copy,TaggingDirective:'REPLACE'}));
  else if(!large) await client.send(new PutObjectCommand({...destination,Body:bytes,ContentType:'message/rfc822'}));
  else {
    const end=Math.max(FIRST_PART,5*MiB+removed);if(end>=size)throw headerLimit();
    const first=end===original.length?bytes:Buffer.concat([bytes,await get(original.length,end,true)]);
    const {UploadId}=await client.send(new CreateMultipartUploadCommand({...destination,ContentType:'message/rfc822'}));
    if(!UploadId) throw new Error('Missing S3 multipart upload id');
    const upload={Bucket:bucket,Key:key,UploadId};
    try {
      const a=await client.send(new UploadPartCommand({...upload,PartNumber:1,Body:first}));
      const b=await client.send(new UploadPartCopyCommand({...upload,...copy,PartNumber:2,CopySourceRange:`bytes=${end}-${size-1}`}));
      if(!a.ETag || !b.CopyPartResult?.ETag)throw new Error('Incomplete S3 multipart upload');
      await client.send(new CompleteMultipartUploadCommand({...upload,MultipartUpload:{Parts:[{PartNumber:1,ETag:a.ETag},{PartNumber:2,ETag:b.CopyPartResult.ETag}]}}));
    } catch(error){try{await client.send(new AbortMultipartUploadCommand(upload));}catch{/* bucket lifecycle also aborts abandoned uploads */}throw error;}
  }
  return {bytes,sizeBytes:size-removed,large};
}
