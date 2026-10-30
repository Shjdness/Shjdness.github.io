const windows=new Map<string,{count:number;until:number}>();
/** Bounded per-isolate burst protection; daily D1 gates remain the durable limit. */
export function allowBurst(key:string,limit=240,windowMs=60000,now=Date.now()) {
  const old=windows.get(key);
  if(old && old.until>now) {if(old.count>=limit)return false; old.count++;return true;}
  windows.delete(key); windows.set(key,{count:1,until:now+windowMs});
  while(windows.size>2048)windows.delete(windows.keys().next().value!);
  return true;
}
