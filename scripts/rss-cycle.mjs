// Lifecycle control only. Never print response bodies, tokens, or source titles.
import {appendFile} from 'node:fs/promises';
const phase=process.argv[2],endpoint=(process.env.RSS_SYNC_ENDPOINT||'https://rin-server.1322589722.workers.dev').replace(/\/$/,'');
const token=process.env.RSS_SYNC_TOKEN,runKey=`${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
if(!token||!/^\d{1,30}-\d{1,10}$/.test(runKey)||!['begin','finish'].includes(phase))throw Error('RSS cycle configuration missing');
const body=phase==='begin'?{runKey}:{runKey,day:process.env.RSS_CYCLE_DAY,succeeded:process.env.RSS_CYCLE_SUCCEEDED==='true'};
const response=await fetch(`${endpoint}/rss/sync/cycle/${phase}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
if(!response.ok)throw Error(`RSS cycle ${phase} unavailable (${response.status})`);
const result=await response.json();
if(phase==='begin'){
  if(typeof result.admitted!=='boolean'||!/^\d{4}-\d{2}-\d{2}$/.test(result.day)||!process.env.GITHUB_OUTPUT)throw Error('Invalid RSS cycle admission');
  await appendFile(process.env.GITHUB_OUTPUT,`admitted=${result.admitted}\nday=${result.day}\n`);
  console.log(result.admitted?'Daily RSS cycle admitted':'Daily RSS cycle already claimed; skipping duplicate fetch');
}else if(result.settled!==true)throw Error('RSS cycle finish not confirmed');
else console.log('Daily RSS cycle settled');
