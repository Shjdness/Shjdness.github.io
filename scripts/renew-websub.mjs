// Metadata-only lease renewal. It does not refetch feeds or start backfills.
const endpoint=(process.env.RSS_SYNC_ENDPOINT || 'https://rin-server.1322589722.workers.dev').replace(/\/$/,'');
const token=process.env.RSS_SYNC_TOKEN;
if(!token)throw Error('RSS_SYNC_TOKEN is required');
let offset=0,totalFailed=0,status;
for(;;) {
  const response=await fetch(endpoint+'/rss/sync/renew-websub',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({offset,limit:5}),signal:AbortSignal.timeout(90000)});
  if(response.status===429||response.status===503){console.warn('WebSub renewal paused by quota/rate guard; daily polling remains available');break;}
  if(!response.ok)throw Error(`WebSub renewal failed: HTTP ${response.status}`);
  const result=await response.json();
  totalFailed+=result.failed.length;status=result.status;
  if(!result.hasMore)break;
  if(!Number.isInteger(result.nextOffset)||result.nextOffset<=offset)throw Error('WebSub renewal did not advance');
  offset=result.nextOffset;
}
console.log(JSON.stringify({websub:status,failedRequests:totalFailed}));
if(totalFailed)console.warn('Some leases need another daily renewal; no feed data was modified');
