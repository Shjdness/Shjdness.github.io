import {expect,it,vi} from 'vitest';
import {reportQQMailProvider,type QQSMTPConnect} from './report-mail-qq';
import {mailFixture,now} from './report-mail-fixture';
import {requestReportVerification} from './report-mail-delivery';
const config={identity:'qq-fixture-v1',from:'fixture_sender@qq.com',to:'fixture@example.invalid',authorizationCode:'abcdefghijklmnop'};
const message={subject:'夏令时电波 · 昨日复盘 '.repeat(5),text:'真实统计替身\n.\nDATA\r\nQUIT\n只作为正文',html:'<p>unused</p>',to:config.to,deliveryKey:'a'.repeat(64)};

function transport(patch:{at?:number;response?:string;greeting?:string;disconnect?:boolean;stall?:boolean;fragment?:boolean;openedStall?:boolean}={}){
  let input:ReadableStreamDefaultController<Uint8Array>,stage=0,closed=false;
  const writes:string[]=[],encode=new TextEncoder();
  const push=(s:string)=>{if(patch.fragment)for(const char of s)input.enqueue(encode.encode(char));else input.enqueue(encode.encode(s));};
  const socket={
    readable:new ReadableStream<Uint8Array>({start(controller){input=controller;if(!patch.openedStall)push(patch.greeting??'220 smtp.qq.com ready\r\n');}}),
    writable:new WritableStream<Uint8Array>({write(value){
      writes.push(new TextDecoder().decode(value));const at=stage++;
      if(patch.at===at){if(patch.disconnect){input.close();return;}if(patch.stall)return;push(patch.response??'550 rejected\r\n');return;}
      push(['250-smtp.qq.com\r\n250 AUTH LOGIN PLAIN\r\n','334 VXNlcm5hbWU6\r\n','334 UGFzc3dvcmQ6\r\n','235 authenticated\r\n','250 sender accepted\r\n','250 recipient accepted\r\n','354 end with dot\r\n','250 queued\r\n'][at]??'221 bye\r\n');
    }}),
    opened:patch.openedStall?new Promise(()=>{}):Promise.resolve({}),closed:Promise.resolve(),close:vi.fn(async()=>{if(!closed){closed=true;try{input.close();}catch{}}}),
  };
  const connect=vi.fn<QQSMTPConnect>(()=>socket);return {connect,writes,socket};
}

it('uses fixed QQ TLS465 and bounded UTF8 MIME without header injection or body command escape',async()=>{
  const t=transport({fragment:true}),provider=reportQQMailProvider({...config,connect:t.connect});
  expect(await provider.submit(message,new AbortController().signal)).toEqual({state:'accepted',id:'qq-'+message.deliveryKey});
  expect(t.connect.mock.calls).toEqual([[{hostname:'smtp.qq.com',port:465},{secureTransport:'on',allowHalfOpen:false}]]);
  expect(t.writes.slice(0,7)).toEqual(['EHLO shjdness.github.io\r\n','AUTH LOGIN\r\n',btoa(config.from)+'\r\n',btoa(config.authorizationCode)+'\r\n',`MAIL FROM:<${config.from}>\r\n`,`RCPT TO:<${config.to}>\r\n`,'DATA\r\n']);
  const wire=t.writes[7],parts=wire.split('\r\n\r\n');
  const encodedSubject=wire.match(/=\?UTF-8\?B\?[^?]+\?=/g)!;
  expect(encodedSubject.every(v=>v.length<=75)).toBe(true);
  const subject=encodedSubject.map(v=>new TextDecoder().decode(Uint8Array.from(atob(v.slice(10,-2)),c=>c.charCodeAt(0)))).join('');expect(subject).toBe(message.subject);
  const body=parts[1].slice(0,-3).replace(/\r\n/g,'');expect(new TextDecoder().decode(Uint8Array.from(atob(body),c=>c.charCodeAt(0)))).toBe(message.text);
  expect(wire.split('\r\n').every(line=>line.length<=998)).toBe(true);expect(wire).not.toContain(message.html);expect(wire).not.toContain(config.authorizationCode);expect(t.socket.close).toHaveBeenCalled();
});

it('rejects wrong mailbox, invalid/reused authorization code and unsafe message before any connection',async()=>{
  const t=transport();
  for(const patch of [{from:'fixture@other.invalid'},{authorizationCode:'not-a-valid-code'},{authorizationCode:'abcdefghijklmnop\r\n'},{disallowedSecrets:[config.authorizationCode]}])expect(()=>reportQQMailProvider({...config,...patch,connect:t.connect})).toThrow('Invalid');
  const provider=reportQQMailProvider({...config,connect:t.connect});
  for(const patch of [{to:'other@example.invalid'},{subject:'inject\r\nBcc: victim@example.invalid'},{deliveryKey:'not-a-key'},{text:'x'.repeat(20000)}])expect(await provider.submit({...message,...patch},new AbortController().signal)).toEqual({state:'rejected'});
  expect(t.connect).not.toHaveBeenCalled();
});

it('requires explicit SMTP stages and never sends body after auth/envelope refusal',async()=>{
  for(const at of [0,1,2,3,4,5,6,7]){
    const t=transport({at,response:at===3?'535 authentication failed\r\n':'550 refused\r\n'});
    expect(await reportQQMailProvider({...config,connect:t.connect}).submit(message,new AbortController().signal)).toEqual({state:'rejected'});
    expect(t.writes).toHaveLength(at+1);expect(t.connect).toHaveBeenCalledOnce();expect(t.socket.close).toHaveBeenCalled();
  }
  const t=transport({at:0,response:'250-smtp.qq.com\r\n250 AUTH PLAIN\r\n'});
  expect(await reportQQMailProvider({...config,connect:t.connect}).submit(message,new AbortController().signal)).toEqual({state:'rejected'});expect(t.writes).toHaveLength(1);
});

it('bounds reply size/lines, closes stalled TLS and DATA and keeps lost acceptance unknown without retry',async()=>{
  for(const patch of [{greeting:'220 '+ 'x'.repeat(512)+'\r\n'},{greeting:'220-bad\r\n250 different\r\n'},{greeting:('220-line\r\n').repeat(65)+'220 done\r\n'},{greeting:'220 ready\r\n250 unsolicited\r\n'},{at:7,disconnect:true},{at:7,stall:true},{openedStall:true}]){
    const t=transport(patch);expect(await reportQQMailProvider({...config,connect:t.connect,timeoutMs:20}).submit(message,new AbortController().signal)).toEqual({state:'unknown'});
    expect(t.connect).toHaveBeenCalledOnce();expect(t.socket.close).toHaveBeenCalled();
  }
  const controller=new AbortController(),t=transport({at:7,stall:true}),pending=reportQQMailProvider({...config,connect:t.connect}).submit(message,controller.signal);controller.abort();
  expect(await pending).toEqual({state:'unknown'});expect(t.connect.mock.calls.length).toBeLessThanOrEqual(1);
});

it('shares durable verification claim and budget across concurrent SMTP calls and never replays unknown',async()=>{
  for(const disconnect of [false,true]){
    const f=await mailFixture();try{
      await f.configure(config.to);const t=transport(disconnect?{at:7,disconnect:true}:{}),provider=reportQQMailProvider({...config,connect:t.connect});
      const options={db:f.raw,ownerId:1,vault:f.vault,provider,now};
      await Promise.all(Array.from({length:5},()=>requestReportVerification(options)));
      expect(t.connect).toHaveBeenCalledOnce();expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_report_mail_admissions').get().n).toBe(1);
      expect(f.sqlite.prepare('SELECT state FROM life_report_mail_deliveries').get().state).toBe(disconnect?'unknown':'accepted');
      await requestReportVerification(options);expect(t.connect).toHaveBeenCalledOnce();
      const rows=JSON.stringify(f.sqlite.prepare('SELECT * FROM life_report_mail_deliveries').all());expect(rows).not.toContain(config.authorizationCode);expect(rows).not.toContain(config.from);expect(rows).not.toContain(config.to);
    }finally{f.sqlite.close();}
  }
});
