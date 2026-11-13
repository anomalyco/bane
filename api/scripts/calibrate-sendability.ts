// Offline, no workspace access, no real recipients. Both controls use the *same* young sender as the fixtures.
import { emailPreviewCorpus } from './email-preview-corpus.js';
import { checkMail } from '../src/sendability.js';
import type { CheckMail } from '../src/sendability-schema.js';
import type { CheckContext } from '../src/sendability-context.js';

const ctx:CheckContext={domain:{verified:true,dkim:true,fromSpf:true,spf:false,mailFrom:false,dmarc:'reject',rua:false,ageDays:4,pool:'probation'},
  standing:{score:null,warmup:true,accepted:33,bounced:0,complained:0,daily:100}};
const fixtures:CheckMail[]=emailPreviewCorpus.map((f,i)=>({from:'render-test@bane.mx',stream:'transactional',subject:`[Bane render test ${String(i+1).padStart(2,'0')}/16] ${f.title}`,html:f.html,text:`Synthetic render test: ${f.title}`}));
const controls:CheckMail[]=[{from:'Bane Billing <billing@bane.mx>',stream:'transactional',subject:'Receipt for your November workspace subscription',
  html:'<h1>Payment received</h1><p>Your November workspace subscription has renewed. We charged $29 to the card ending in 4321. Your next billing date is December 13.</p><p><a href="https://bane.mx/account/billing">View your receipt</a> or reply to this email with any questions.</p>',
  text:'Payment received. Your November workspace subscription has renewed. We charged $29 to the card ending in 4321. Your next billing date is December 13. View your receipt at https://bane.mx/account/billing or reply to this email with any questions.'},
  {from:'Bane Dispatch <dispatch@bane.mx>',stream:'marketing',subject:'November dispatch: a clearer view of your deliveries',
    html:'<h1>November dispatch</h1><p>This month we added a delivery timeline so you can see when a receipt arrives. The new guide explains what to look for when a delivery takes longer than usual.</p><p><a href="https://bane.mx/guides/delivery">Read the delivery guide</a></p><p>You subscribed to monthly updates from Bane. <a href="https://bane.mx/unsubscribe">Unsubscribe</a><br>Bane, 42 Alder Street, Portland OR 97201</p>',
    text:'November dispatch. This month we added a delivery timeline so you can see when a receipt arrives. The new guide explains what to look for when a delivery takes longer than usual. Read the delivery guide: https://bane.mx/guides/delivery. You subscribed to monthly updates from Bane. Unsubscribe: https://bane.mx/unsubscribe. Bane, 42 Alder Street, Portland OR 97201',
    headers:{'List-Unsubscribe':'<https://bane.mx/unsubscribe>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}];
for (const [i,m] of [...fixtures,...controls].entries()) {
  const r=await checkMail(m,ctx);
  console.log(`| ${emailPreviewCorpus[i]?.title??m.stream} | ${r.score} | ${r.findings.filter(f=>['content','headers','size'].includes(f.category) && f.severity!=='info').map(f=>f.ruleId).join(', ')||'—'} |`);
}
const times:number[]=[];
for(let i=0;i<120;i++){const start=performance.now();await checkMail(controls[i%2]!,ctx);if(i>=20)times.push(performance.now()-start);}
console.log(`Engine p95, local warm controls (100 calls): ${times.sort((a,b)=>a-b)[94]!.toFixed(2)} ms`);
