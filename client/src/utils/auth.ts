import { getCookie } from "typescript-cookie";

export function headersWithAuth() {
    const token=getCookie('token');
    return {
        ...(token ? {'Authorization':`Bearer ${token}`} : {})
    }
}

export function apiErrorMessage(value:unknown) {
    if(typeof value==='string')return value;
    if(value && typeof value==='object' && 'message' in value && typeof value.message==='string')return value.message;
    return '请求失败，请稍后重试';
}
