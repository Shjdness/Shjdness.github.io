/** Only the native socket contract used by the SMTP adapter. Client API type
 * inference follows server modules; loading all Worker globals there would
 * replace browser Response.json() types. No runtime polyfill or TLS override. */
declare module 'cloudflare:sockets' {
  export function connect(address:{hostname:string;port:number},options:{secureTransport:'on';allowHalfOpen:false}):{
    readable:ReadableStream<Uint8Array>;
    writable:WritableStream<Uint8Array>;
    opened:Promise<unknown>;
    closed:Promise<void>;
    close():Promise<void>;
  };
}
