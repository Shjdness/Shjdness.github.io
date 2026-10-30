import Container from "typedi"
import type { Env } from "../db/db"
import type { DB } from "../_worker"
import {AsyncLocalStorage} from 'node:async_hooks';

export const envToken = 'env'
export const dbToken = 'db'
const context=new AsyncLocalStorage<{env:Env;db:DB}>();
export const requestContext=()=>context.getStore();
export const runRequestContext=<T>(env:Env,db:DB,run:()=>T)=>context.run({env,db},run);
// Container is retained only for standalone scripts/tests without a request.
export const getEnv = () => context.getStore()?.env ?? Container.get<Env>(envToken)
export const getDB = () => context.getStore()?.db ?? Container.get<DB>(dbToken)
