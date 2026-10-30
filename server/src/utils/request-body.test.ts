import {describe,it,expect} from 'vitest';
import {BodyLimitError,readLimitedBody} from './request-body';
describe('raw request bounds',()=>{
  it('cancels a streamed body that exceeds the limit without a length header',async()=>{
    let cancelled=false;
    const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(6));controller.enqueue(new Uint8Array(6));},cancel(){cancelled=true;}});
    const request=new Request('http://localhost',{method:'POST',body,duplex:'half'} as any);
    await expect(readLimitedBody(request,10)).rejects.toBeInstanceOf(BodyLimitError);
    expect(cancelled).toBe(true);
  });
  it('keeps the exact bytes needed for signature verification',async()=>{
    const bytes=new Uint8Array([0,255,128,10]);
    expect(await readLimitedBody(new Request('http://localhost',{method:'POST',body:bytes}),4)).toEqual(bytes);
  });
});
