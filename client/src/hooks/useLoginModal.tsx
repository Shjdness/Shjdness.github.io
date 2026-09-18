import { t } from "i18next";
import { useCallback, useState } from "react";
import ReactModal from "react-modal";
import { setCookie } from "typescript-cookie";
import { Button, ButtonWithLoading } from "../components/button";
import { Icon } from "../components/icon";
import { Input } from "../components/input";
import { client, oauth_url } from "../main";

export function useLoginModal(onClose?: () => void) {
    const [accessCode, setAccessCode] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [isOpened, setIsOpened] = useState(false);
    const onGuestLogin = useCallback(async () => {
        if (!accessCode || loading) return
        setLoading(true)
        setError('')
        const { data, error } = await client.user.guest.post({ code: accessCode })
        setLoading(false)
        if (error || !data || typeof data === 'string') {
            const errorValue = error?.value as string | undefined
            const message = errorValue === 'Too many attempts. Try again later'
                ? t('login.guest.rate_limited')
                : errorValue === 'Guest access is not configured'
                    ? t('login.guest.not_configured')
                    : t('login.guest.invalid')
            setError(message)
            return
        }
        setCookie('token', data.token, { expires: 7, sameSite: 'lax', secure: true })
        setIsOpened(false)
        onClose?.()
        window.location.reload()
    }, [accessCode, loading, onClose])
    const LoginModal = useCallback(() => {
        return (
            <ReactModal
                isOpen={isOpened}
                style={{
                    content: {
                        top: "50%",
                        left: "50%",
                        right: "auto",
                        bottom: "auto",
                        marginRight: "-50%",
                        transform: "translate(-50%, -50%)",
                        padding: "0",
                        border: "none",
                        borderRadius: "16px",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "center",
                        alignItems: "center",
                        background: "none",
                    },
                    overlay: {
                        backgroundColor: "rgba(0, 0, 0, 0.5)",
                        zIndex: 1000,
                    },
                }}
                onRequestClose={() => setIsOpened(false)}
            >
                <div className="glass-panel rounded-3xl bg-w w-[min(92vw,26rem)] flex flex-col items-center p-6 gap-5 t-primary">
                    <div className="flex w-full items-center gap-3">
                        <img src="/guest-avatar.jpg" alt="悲若兮" className="h-14 w-14 rounded-2xl object-cover border border-white/30" />
                        <div>
                            <p className="text-xl font-semibold">{t('login.guest.name')}</p>
                            <p className="text-xs t-secondary">Hasta que Llegue la Muerte</p>
                        </div>
                    </div>
                    <div className="w-full space-y-3">
                        <Input
                            value={accessCode}
                            setValue={setAccessCode}
                            placeholder={t('login.guest.code')}
                            type="password"
                            autofocus
                            onSubmit={onGuestLogin}
                        />
                        {error && <p className="text-sm text-red-500">{error}</p>}
                        <ButtonWithLoading title={t('login.guest.action')} onClick={onGuestLogin} loading={loading} />
                        <p className="text-xs t-secondary">{t('login.guest.scope')}</p>
                    </div>
                    <div className="w-full border-t border-white/15 pt-4 flex items-center justify-between">
                        <span className="text-xs t-secondary">{t('login.owner')}</span>
                        <div className="flex items-center gap-2">
                            <Icon label={t('github_login')} name="ri-github-line" onClick={() => {
                                window.location.href = `${oauth_url}`
                            }} hover={true} />
                            <Button title={t('close')} secondary onClick={() => setIsOpened(false)} />
                        </div>
                    </div>
                </div>
            </ReactModal>
        )
    }, [accessCode, error, isOpened, loading, onGuestLogin])
    return { LoginModal, setIsOpened }
}
