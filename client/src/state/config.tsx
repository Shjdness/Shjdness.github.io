import { createContext } from "react";

const defaultFavicon = process.env.AVATAR ? `//wsrv.nl/?url=${encodeURIComponent(process.env.AVATAR)}&w=144&h=144&mask=circle` : '/favicon.ico';
export const defaultClientConfig = new Map(Object.entries({
    "favicon": defaultFavicon,
    "counter.enabled": true,
}))

export class ConfigWrapper {
    config: any;
    defaultConfig: Map<string, any>
    constructor(config: any, defaultConfig: Map<string, any>) {
        this.config = config;
        this.defaultConfig = defaultConfig;
    }
    get<T>(key: string) {
        const value = this.config[key];
        if (value !== undefined && value !== "") {
            return value as T;
        }
        if (this.defaultConfig.has(key)) {
            return this.defaultConfig.get(key) as T;
        }
    }
    default<T>(key: string) {
        return this.defaultConfig.get(key) as T;
    }
}

export const defaultClientConfigWrapper = new ConfigWrapper({}, defaultClientConfig);

export const ClientConfigContext = createContext<ConfigWrapper>(defaultClientConfigWrapper);
