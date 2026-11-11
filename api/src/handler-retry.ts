import {ApiError} from './core.js';
export class ActionRetry extends ApiError {
  constructor(code:string,readonly afterMs:number=0){super(503,code,'Handler delivery will be retried.',undefined,true)}
}
export function actionDelay(attempt:number,afterMs:number,random=Math.random){const base=Math.min(12*3600000,15000*4**Math.max(0,attempt-1));return Math.max(afterMs,Math.round(base*(0.75+0.5*random())))}
export function retryAfterMs(value?:string|null){if(!value)return 0;const ms=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-Date.now();return Number.isFinite(ms)?Math.max(0,Math.min(ms,7*86400000)):0}
