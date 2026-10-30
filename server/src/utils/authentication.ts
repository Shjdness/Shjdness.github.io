import {jwtVerify} from 'jose';
import {eq} from 'drizzle-orm';
import type {DB} from '../_worker';
import type {Env} from '../db/db';
import {users} from '../db/schema';
import {canAccessLife,roleForUser,type Role} from './roles';
type Identity={uid?:number;username?:string;role?:Role;admin?:boolean;writer?:boolean;lifeAccess?:boolean};
const requests=new WeakMap<Request,Promise<Identity>>();
/** One verification per request; never share a user's identity across requests. */
export function authenticate(request:Request,db:DB,env:Env):Promise<Identity> {
  const cached=requests.get(request);if(cached)return cached;
  const result=(async():Promise<Identity>=>{
    const value=request.headers.get('authorization');
    if(!value?.startsWith('Bearer ')||value.length>8192)return {};
    let id:unknown;
    try {const {payload}=await jwtVerify(value.slice(7),new TextEncoder().encode(env.JWT_SECRET),{algorithms:['HS256'],requiredClaims:['exp']});id=payload.id;}
    catch {return {};}
    if(!Number.isSafeInteger(id)||Number(id)<=0)return {};
    const user=await db.query.users.findFirst({where:eq(users.id,id as number)});if(!user)return {};
    const role=roleForUser(user);
    return {uid:user.id,username:user.username,role,admin:role==='owner',writer:role==='owner'||role==='trusted',lifeAccess:canAccessLife(role)};
  })();
  requests.set(request,result);return result;
}
