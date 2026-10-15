import { useEffect } from "react";
import { setCookie } from "typescript-cookie";

export function CallbackPage() {
    useEffect(() => {
        const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
        if (token) {
            window.history.replaceState(null, '', '/callback');
            setCookie('token', token, { expires: 7, path: '/', sameSite: 'lax', secure: window.location.protocol === 'https:' })
            // Start a fresh App instance so the profile is always loaded for
            // the identity in the newly issued token.
            window.location.replace('/');
        }
    }, []);
    return (<>
        <div className="w-screen h-screen flex justify-center items-center">
            <div className="text-center text-black p-4 text-xl font-bold">
                <p>
                    Waiting...
                </p>
            </div>
        </div>
    </>)
}
