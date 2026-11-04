import {useEffect,useState} from 'react';
import {getSyncQueue,onLocalChange,resolveSyncConflict,SyncConflictError,type SyncItem} from '../../data/local-first';
import {CLOUD_REFRESH_EVENT,lifeApi} from './model';
import {sendQueuedMutation} from './sync';

export function SyncConflicts() {
  const [items,setItems]=useState<SyncItem[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const refresh=()=>{void getSyncQueue().then(queue=>setItems(queue.filter(item=>item.status==='conflict')));};
  useEffect(()=>{refresh();return onLocalChange(refresh);},[]);
  if(!items.length)return null;
  const resolve=async(item:SyncItem,local:boolean)=>{
    if(busy)return;setBusy(true);setMessage('');
    try {
      await resolveSyncConflict(item,local,async payload=>{
        if(item.entity==='basic'){await sendQueuedMutation(item);return;}
        const current=item.remote as any;
        // Resolve only against the version the user has actually reviewed.
        const result=await lifeApi<any>(`/life/notes/${payload.date}`,{method:'POST',body:JSON.stringify({content:payload.content,updatedAt:new Date().toISOString(),baseUpdatedAt:current?.updatedAt,baseRevision:current?.revision})});
        if(result.saved!==true)throw new SyncConflictError(result.note);
      });
      refresh();setMessage('已处理，原始本地版本已留存在本机恢复存档');
      window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
    } catch(error) {setMessage(error instanceof Error?error.message:'处理失败，原始记录已保留');}
    finally{setBusy(false);}
  };
  return <details className="life-backup-row"><summary>{items.length} 条修改需要合并（原始内容已保留）</summary>{items.map(item=><section key={item.id}><p>{(item.payload as any).date}：本地内容</p><pre style={{whiteSpace:'pre-wrap'}}>{(item.payload as any).content}</pre><p>{item.entity==='basic'?'每日事项保存冲突（不会自动重试）':'检测到的云端版本'}</p><pre style={{whiteSpace:'pre-wrap'}}>{(item.remote as any)?.content || (item.remote as any)?.message || '空内容'}</pre><button disabled={busy} onClick={()=>void resolve(item,true)}>{item.entity==='basic'?'核对日期容量后重试':'保留本地内容并更新云端'}</button><button disabled={busy} onClick={()=>void resolve(item,false)}>保留本机存档，采用云端版本</button></section>)}{message&&<p role="status">{message}</p>}</details>;
}
