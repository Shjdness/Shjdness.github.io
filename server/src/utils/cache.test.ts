import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import Container from 'typedi';
import {envToken,dbToken} from './di';
const mocks=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('./s3',()=>({createS3Client:()=>({send:mocks.send})}));
import {CacheImpl} from './cache';
describe('cache storage boundaries',()=>{
  it('copies legacy configuration to private durable storage before removing the public object',async()=>{
    let row:any;const order:string[]=[];
    Container.set(envToken,{S3_ACCESS_HOST:'https://assets.invalid',S3_BUCKET:'test',S3_CACHE_FOLDER:'cache/'});
    Container.set(dbToken,{query:{info:{findFirst:async()=>row}},insert:()=>({values:(value:any)=>({onConflictDoNothing:async()=>{row=value;order.push('private-write');},onConflictDoUpdate:async()=>{row=value;order.push('private-update');}})})});
    mocks.send.mockImplementation(async(command:any)=>{
      if(command.constructor.name==='GetObjectCommand')return {Body:{transformToString:async()=>'{"WEBHOOK_URL":"test-only"}'}};
      if(command.constructor.name==='DeleteObjectCommand'){expect(row).toBeDefined();order.push('delete-public');return {};}
      throw Error('Public write forbidden');
    });
    const cache=new CacheImpl('server.config');await Promise.all([cache.all(),cache.all()]);
    expect(order).toEqual(['private-write','delete-public']);
    await cache.set('WEBHOOK_URL','updated');expect(order.at(-1)).toBe('private-update');
    expect(JSON.parse(row.value).WEBHOOK_URL).toBe('updated');
  });
  it('bounds public cache and never persists a public read miss',async()=>{
    mocks.send.mockClear();const cache=new CacheImpl();
    for(let i=0;i<140;i++)await cache.set('key'+i,i);
    expect(cache.cache.size).toBe(128);expect(await cache.get('key0')).toBeUndefined();
    expect(await cache.get('key139')).toBe(139);expect(mocks.send).not.toHaveBeenCalled();
  });
});
