// Unicode scalars only: Postgres text/jsonb reject NUL and unpaired UTF-16 surrogates (including slices).
export const mailText=(s:string)=>s.replace(/[\u0000\uD800-\uDFFF]/gu,'\uFFFD');
export const mailJson=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='string'?mailText(v):v);
