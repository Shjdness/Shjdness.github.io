/** Notifications are optional: failure must not undo a committed comment. */
export async function notify(webhook_url: string, message: string) {
    if (!webhook_url) return false;
    try {
        const url=new URL(webhook_url);
        if(url.protocol!=='https:' || url.username || url.password || url.hash)return false;
        const response=await fetch(url,{
            method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
            headers:{'Content-Type':'application/json'},body:JSON.stringify({content:message}),
        });
        await response.body?.cancel();
        return response.ok;
    } catch {return false;}
}
