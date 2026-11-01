// Inbox proof stays in memory only. Never put it in storage, query parameters,
// telemetry, error messages or an automatic request on page load.
let pending:string|null=null,boundOwner:number|null=null;
export function captureReportVerification(){
  if(window.location.pathname!=='/life/reports'||!window.location.hash.startsWith('#verify='))return;
  const raw=window.location.hash.slice(8);
  try{window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);}
  catch{pending=null;window.location.hash='';return;}
  pending=/^[A-Za-z0-9_-]{43}$/.test(raw)?raw:null;boundOwner=null;
  window.dispatchEvent(new Event('report-verification-ready'));
}
export function pendingReportVerification(ownerId:number){
  if(boundOwner!==null&&boundOwner!==ownerId)pending=null;
  boundOwner=ownerId;return pending;
}
export function clearReportVerification(){pending=null;}
