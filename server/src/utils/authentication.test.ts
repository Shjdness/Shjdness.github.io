import {SignJWT} from 'jose';
import {it,expect,vi} from 'vitest';
import {authenticate} from './authentication';
it('keeps identities request-local, requires expiry and the existing HS256 algorithm',async()=>{
  const key=new TextEncoder().encode('test-only-authentication-secret');
  const token=async(id:number,alg='HS256',expiry=true)=>{let jwt=new SignJWT({id}).setProtectedHeader({alg});if(expiry)jwt=jwt.setExpirationTime('1h');return jwt.sign(key);};
  const db={query:{users:{findFirst:vi.fn(async()=>({id:1,username:'test',permission:1}))}}} as any;
  const env={JWT_SECRET:new TextDecoder().decode(key)} as any;
  const request=new Request('https://api.invalid',{headers:{authorization:'Bearer '+await token(1)}});
  expect((await authenticate(request,db,env)).uid).toBe(1);await authenticate(request,db,env);
  expect(db.query.users.findFirst).toHaveBeenCalledTimes(1);
  expect((await authenticate(new Request('https://api.invalid'),db,env)).uid).toBeUndefined();
  for(const value of [await token(1,'HS512'),await token(1,'HS256',false),'invalid']) {
    expect((await authenticate(new Request('https://api.invalid',{headers:{authorization:'Bearer '+value}}),db,env)).uid).toBeUndefined();
  }
});
