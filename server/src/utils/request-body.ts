export class BodyLimitError extends Error {
  constructor(){super('Request body is too large');}
}

export function hasBodyLimitError(error:unknown):boolean {
  for(let depth=0;error instanceof Error && depth<5;depth++,error=error.cause)if(error instanceof BodyLimitError)return true;
  return false;
}

/** Keep normal streaming/multipart parsing while bounding actual bytes read. */
export function limitRequestBody(request:Request,limit:number) {
  if(!request.body)return request;
  let size=0;
  const body=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
    size+=chunk.byteLength;if(size>limit)throw new BodyLimitError();controller.enqueue(chunk);
  }}));
  const init:RequestInit & {duplex?:'half'}={body,duplex:'half'};
  return new Request(request,init);
}

/** Read raw bytes once, enforcing an actual streaming bound, not just a header. */
export async function readLimitedBody(request:Pick<Request, 'body' | 'headers'>,limit:number) {
  if(Number(request.headers.get('content-length')||0)>limit)throw new BodyLimitError();
  if(!request.body)return new Uint8Array();
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();throw new BodyLimitError();}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const result=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
  return result;
}
