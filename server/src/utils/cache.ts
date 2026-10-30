import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from 'drizzle-orm';
import { info } from '../db/schema';
import path from "node:path";
import Container, { Service } from "typedi";
import type { DB } from "../_worker";
import type { Env } from "../db/db";
import { getDB, getEnv,requestContext } from "./di";
import { createS3Client } from "./s3";

// Cache Utils for storing data in memory and persisting to S3
// DO NOT USE THIS TO STORE SENSITIVE DATA

@Service()
export class CacheImpl {
    cache: Map<string, any> = new Map<string, any>();
    db: DB;
    env: Env;
    cacheUrl: string;
    type: string;
    loaded: boolean = false;
    loading?: Promise<void>;
    expires = new Map<string, number>();
    s3 = createS3Client();

    constructor(type: string = "cache") {
        this.type = type;
        this.db = getDB();
        this.env = getEnv();
        this.cache = new Map<string, any>();
        const slash = this.env.S3_ACCESS_HOST.endsWith('/') ? '' : '/';
        this.cacheUrl = this.env.S3_ACCESS_HOST + slash + path.join(this.env.S3_CACHE_FOLDER || 'cache', `${type}.json`);
    }

    async load() {
        if (this.loaded) return;
        if (this.loading) return this.loading;
        this.loading = this.loadOnce().finally(() => { this.loading = undefined; });
        return this.loading;
    }

    private async loadOnce() {
        if (this.type === 'cache') { this.loaded = true; return; }
        let data: Record<string, unknown>;
        if (this.type === 'server.config') {
            const key = 'private:server.config:v1';
            let imported=false;
            let record = await this.db.query.info.findFirst({ where: eq(info.key, key) });
            const objectKey = path.posix.join(this.env.S3_CACHE_FOLDER || 'cache', 'server.config.json');
            if (!record) {
                imported=true;
                try {
                    const legacy = await this.s3.send(new GetObjectCommand({ Bucket:this.env.S3_BUCKET, Key:objectKey }));
                    data = JSON.parse(await legacy.Body!.transformToString());
                } catch (error: any) {
                    if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
                    data = {};
                }
                if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('Invalid private configuration');
                await this.db.insert(info).values({key,value:JSON.stringify(data)}).onConflictDoNothing();
                record = await this.db.query.info.findFirst({ where:eq(info.key,key) });
                if (!record) throw Error('Private configuration was not durably saved');
            }
            data = JSON.parse(record.value);
            // Remove only after a durable private copy exists; never log values.
            if(imported)await this.s3.send(new DeleteObjectCommand({ Bucket:this.env.S3_BUCKET, Key:objectKey }));
        } else {
            const response = await fetch(this.cacheUrl, {signal:AbortSignal.timeout(10000)});
            if (!response.ok && response.status !== 404) throw Error('Configuration is unavailable');
            data = response.status === 404 ? {} : await response.json() as Record<string,unknown>;
        }
        this.cache = new Map(Object.entries(data));
        this.loaded = true;
    }
    async all() {
        if (!this.loaded) {
            await this.load();
        }
        return this.cache;
    }
    async get(key: string) {
        if (!this.loaded) {
            await this.load();
        }
        if (this.type === 'cache' && (this.expires.get(key) || 0) <= Date.now()) {
            this.cache.delete(key); this.expires.delete(key); return undefined;
        }
        return this.cache.get(key);
    }
    async getOrSet<T>(key: string, value: () => Promise<T>) {
        const cached = await this.get(key)
        if (cached !== undefined) {
            console.log('Cache hit', key);
            return cached as T;
        }
        console.log('Cache miss', key);
        const newValue = await value();
        await this.set(key, newValue);
        return newValue;
    }

    async getOrDefault<T>(key: string, defaultValue: T) {
        return this.getOrSet(key, async () => defaultValue);
    }
    

    async set(key: string, value: any, save: boolean = true) {
        if (!this.loaded)
            await this.load();
        this.cache.set(key, value);
        if (this.type === 'cache') {
            this.expires.set(key, Date.now()+60000);
            while (this.cache.size > 128) { const oldest=this.cache.keys().next().value!; this.cache.delete(oldest); this.expires.delete(oldest); }
        }
        if (save) {
            await this.save();
        }
    }

    async delete(key: string, save: boolean = true) {
        if (!this.loaded)
            await this.load();
        this.cache.delete(key);
        this.expires.delete(key);
        if (save) {
            await this.save();
        }
    }

    async deletePrefix(prefix: string) {
        for (let key of this.cache.keys()) {
            console.log('Cache key', key);
            if (key.startsWith(prefix)) {
                console.log('Cache delete', key);
                await this.delete(key, false);
            }
        }
        await this.save();
    }

    async clear() {
        this.cache.clear();
        this.expires.clear();
        await this.save();
    }

    async save() {
        if (this.type === 'cache') return; // Public reads never persist entire maps to R2.
        if (this.type === 'server.config') {
            const key='private:server.config:v1', value=JSON.stringify(Object.fromEntries(this.cache));
            try { await this.db.insert(info).values({key,value}).onConflictDoUpdate({target:info.key,set:{value}}); }
            catch(error) { this.loaded=false; throw error; }
            return;
        }
        const cacheKey = path.join(this.env.S3_CACHE_FOLDER, `${this.type}.json`);
        await this.s3.send(new PutObjectCommand({
            Bucket: this.env.S3_BUCKET,
            Key: cacheKey,
            Body: JSON.stringify(Object.fromEntries(this.cache))
        }));
    }
}

const requestCaches=new WeakMap<Env,Map<string,CacheImpl>>();
function cacheFor(type:string) {
    const context=requestContext();
    if(!context)return Container.get<CacheImpl>(type);
    let caches=requestCaches.get(context.env);
    if(!caches){caches=new Map();requestCaches.set(context.env,caches);}
    let cache=caches.get(type);
    if(!cache){cache=new CacheImpl(type);caches.set(type,cache);}
    return cache;
}
export const PublicCache = () => cacheFor("cache");
export const ServerConfig = () => cacheFor("server.config");
export const ClientConfig = () => cacheFor("client.config");
