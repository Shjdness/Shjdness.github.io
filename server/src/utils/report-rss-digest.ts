import type {D1Database} from '@cloudflare/workers-types';

export type RssDigestBucket={items:number;channels:number;categories:Array<{name:string;items:number;channels:number;listed:Array<{name:string;items:number}>;omittedChannels:number}>;omittedCategories:number;omittedCategoryItems:number};
export type RssDigest={version:1;from:string;toExclusive:string;updates:RssDigestBucket;history:RssDigestBucket;unclassified:RssDigestBucket};
type Row={bucket:'updates'|'history'|'unclassified';source_id:number;category:string;name:string;items:number};
const name=(value:string,fallback:string,max:number)=>value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/g,' ').trim().slice(0,max)||fallback;
const object=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))throw Error('Invalid RSS digest');return v as Record<string,unknown>;};
const count=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('Invalid RSS digest count');return Number(v);};
function bucketValue(input:unknown):RssDigestBucket{
 const v=object(input,['items','channels','categories','omittedCategories','omittedCategoryItems']),items=count(v.items),channels=count(v.channels),omittedCategories=count(v.omittedCategories),omittedCategoryItems=count(v.omittedCategoryItems);
 if(!Array.isArray(v.categories)||v.categories.length>30||items<channels)throw Error('Invalid RSS digest categories');
 const seen=new Set<string>();let listedCount=0;
 const categories=v.categories.map(input=>{
  const c=object(input,['name','items','channels','listed','omittedChannels']),ci=count(c.items),cc=count(c.channels),omittedChannels=count(c.omittedChannels);
  if(typeof c.name!=='string'||c.name!==name(c.name,'其他',100)||seen.has(c.name)||ci<cc||cc<1||!Array.isArray(c.listed)||c.listed.length>10||omittedChannels!==cc-c.listed.length)throw Error('Invalid RSS digest category');
  seen.add(c.name);listedCount+=c.listed.length;
  const listed=c.listed.map(input=>{const s=object(input,['name','items']),n=count(s.items);if(typeof s.name!=='string'||s.name!==name(s.name,'未命名频道',200)||n<1)throw Error('Invalid RSS digest channel');return {name:s.name,items:n};});
  if(listed.reduce((n,s)=>n+s.items,0)>ci)throw Error('Invalid RSS digest sum');return {name:c.name,items:ci,channels:cc,listed,omittedChannels};
 });
 const shownChannels=categories.reduce((n,c)=>n+c.channels,0),shownItems=categories.reduce((n,c)=>n+c.items,0);
 if(listedCount>50||shownItems+omittedCategoryItems!==items||shownChannels>channels||(!omittedCategories&&(shownChannels!==channels||omittedCategoryItems!==0))||(omittedCategories&&(channels-shownChannels<omittedCategories||omittedCategoryItems<omittedCategories)))throw Error('Invalid RSS digest totals');
 return {items,channels,categories,omittedCategories,omittedCategoryItems};
}
/** Strict archive/mail projection; no extra text fields or identity may hitchhike. */
export function rssDigestValue(input:unknown):RssDigest{
 const v=object(input,['version','from','toExclusive','updates','history','unclassified']);
 if(v.version!==1||typeof v.from!=='string'||typeof v.toExclusive!=='string')throw Error('Invalid RSS digest version');
 const interval=rssDigestQuery(1,new Date(v.from),new Date(v.toExclusive));
 if(interval.from!==v.from||interval.toExclusive!==v.toExclusive)throw Error('Invalid RSS digest timestamps');
 return {version:1,from:v.from,toExclusive:v.toExclusive,updates:bucketValue(v.updates),history:bucketValue(v.history),unclassified:bucketValue(v.unclassified)};
}

/** Preserve adjacent second-resolution intervals. We never count a timestamp
 * correction or unchanged re-fetch as a new discovery. First-discovery kind is
 * immutable at ingestion, independent of publication dates and sync metrics. */
export function rssDigestQuery(owner:number,from:Date,to:Date){
 const start=Math.floor(from.getTime()/1000),end=Math.floor(to.getTime()/1000);
 if(!Number.isSafeInteger(owner)||owner<1||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<946684800||end<=start||end-start>8*86400)throw Error('Invalid RSS discovery window');
 return {from:new Date(start*1000).toISOString(),toExclusive:new Date(end*1000).toISOString(),args:[owner,start,end],sql:`SELECT
   CASE WHEN i.discovery_kind IN ('feed','push','fallback') THEN 'updates' WHEN i.discovery_kind='history' THEN 'history' ELSE 'unclassified' END AS bucket,
   s.id AS source_id,s.category,CASE WHEN trim(s.alias)!='' THEN s.alias ELSE s.title END AS name,COUNT(*) AS items
   FROM rss_items i JOIN rss_subscriptions s ON s.id=i.subscription_id AND s.owner_id=i.owner_id
   WHERE i.owner_id=? AND i.created_at>=? AND i.created_at<?
   GROUP BY bucket,s.id,s.category,s.alias,s.title ORDER BY bucket,s.category,items DESC,s.id LIMIT 15001`};
}
function bucket(rows:Row[]):RssDigestBucket{
 let items=0;const categories=new Map<string,{items:number;channels:Array<{name:string;items:number}>}>();
 for(const row of rows){
  if(!Number.isSafeInteger(row.items)||row.items<1||!Number.isSafeInteger(row.source_id)||row.source_id<1||typeof row.category!=='string'||typeof row.name!=='string')throw Error('Invalid RSS discovery aggregate');
  items+=row.items;if(!Number.isSafeInteger(items))throw Error('RSS discovery aggregate overflow');
  const category=name(row.category,'其他',100),entry=categories.get(category)??{items:0,channels:[]};
  entry.items+=row.items;entry.channels.push({name:name(row.name,'未命名频道',200),items:row.items});categories.set(category,entry);
 }
 const all=[...categories].sort((a,b)=>b[1].items-a[1].items||a[0].localeCompare(b[0],'zh-CN'));
 let slots=50;
 const shown=all.slice(0,30).map(([category,entry])=>{
  entry.channels.sort((a,b)=>b.items-a.items||a.name.localeCompare(b.name,'zh-CN'));
  const listed=entry.channels.slice(0,Math.min(10,slots));slots-=listed.length;
  return {name:category,items:entry.items,channels:entry.channels.length,listed,omittedChannels:entry.channels.length-listed.length};
 });
 return {items,channels:rows.length,categories:shown,omittedCategories:all.length-shown.length,omittedCategoryItems:all.slice(30).reduce((n,[,e])=>n+e.items,0)};
}
/** Owner-bound bounded query; result is email-only input, never AI input. It
 * contains channel labels/counts, not article titles, URLs, summaries or owner IDs. */
export async function readRssDigest(db:D1Database,owner:number,from:Date,to:Date):Promise<RssDigest>{
 const query=rssDigestQuery(owner,from,to),rows=await db.prepare(query.sql).bind(...query.args).all<Row>();
 if(!rows.success)throw Error('RSS discovery summary unavailable');
 return rssDigestFromRows(owner,from,to,rows.results);
}
/** Shared with the combined report read transaction; never adds another read. */
export function rssDigestFromRows(owner:number,from:Date,to:Date,input:unknown[]):RssDigest{
 const query=rssDigestQuery(owner,from,to),rows=input as Row[];
 if(!Array.isArray(rows)||rows.length>15000||rows.some(r=>!r||!['updates','history','unclassified'].includes(r.bucket)))throw Error('RSS discovery summary unavailable');
 return rssDigestValue({version:1,from:query.from,toExclusive:query.toExclusive,updates:bucket(rows.filter(r=>r.bucket==='updates')),history:bucket(rows.filter(r=>r.bucket==='history')),unclassified:bucket(rows.filter(r=>r.bucket==='unclassified'))});
}

/** Plain text; HTML callers must escape it. Missing data is handled separately
 * by the caller, never converted to a fabricated zero. Counts include omitted rows. */
export function rssDigestLines(input:RssDigest){
 const value=rssDigestValue(input);
 const lines=[`RSS 新收录窗口：${new Date(value.from).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 至 ${new Date(value.toExclusive).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 前（北京时间）`,'按首次入库统计，不表示均在今天发布。'];
 for(const [title,part] of [['订阅更新',value.updates],['历史补录',value.history],['来源未分类',value.unclassified]] as const){
  lines.push(`${title}：${part.items} 条，${part.channels} 个频道`);
  for(const c of part.categories)lines.push(`- ${c.name}｜${c.items} 条｜${c.listed.map(s=>`${s.name}（${s.items}）`).join('、')}${c.omittedChannels?`；另 ${c.omittedChannels} 个频道，详见站内 RSS`:''}`);
  if(part.omittedCategories)lines.push(`另 ${part.omittedCategories} 个分类、${part.omittedCategoryItems} 条，详见站内 RSS。`);
 }
 return lines;
}
