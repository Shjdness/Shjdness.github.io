import Elysia,{t} from 'elysia';
import {getEnv} from '../../utils/di';
import {beginRssCycle,finishRssCycle} from '../../utils/rss-daily-cycle';

export function cycleRoutes(authorized:(value?:string)=>boolean){
  return new Elysia({aot:false})
    .onAfterHandle(({set})=>{set.headers['Cache-Control']='private, no-store';})
    .post('/sync/cycle/begin',async({headers,set,body})=>{
      if(!authorized(headers.authorization)){set.status=401;return 'Unauthorized';}
      return beginRssCycle(getEnv().DB,body.runKey);
    },{body:t.Object({runKey:t.String({pattern:'^[0-9]{1,30}-[0-9]{1,10}$'})})})
    .post('/sync/cycle/finish',async({headers,set,body})=>{
      if(!authorized(headers.authorization)){set.status=401;return 'Unauthorized';}
      return finishRssCycle(getEnv().DB,body.day,body.runKey,body.succeeded);
    },{body:t.Object({runKey:t.String({pattern:'^[0-9]{1,30}-[0-9]{1,10}$'}),day:t.String({pattern:'^\\d{4}-\\d{2}-\\d{2}$'}),succeeded:t.Boolean()})});
}
