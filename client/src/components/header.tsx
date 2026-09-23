import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactModal from "react-modal";
import Popup from "reactjs-popup";
import { removeCookie } from "typescript-cookie";
import { Link, useLocation } from "wouter";
import { useLoginModal } from "../hooks/useLoginModal";
import { Profile, ProfileContext } from "../state/profile";
import { Button } from "./button";
import { IconSmall } from "./icon";
import { Input } from "./input";
import { Padding } from "./padding";


export function Header({ children }: { children?: React.ReactNode }) {
    const profile = useContext(ProfileContext);
    const { t } = useTranslation()
    const [location] = useLocation()
    const isBlog = location.startsWith('/blog')

    return useMemo(() => (
        <>
            <div className="fixed z-40">
                <div className="w-screen">
                    <Padding className="mx-4 mt-4">
                        <div className="w-full flex justify-between items-center">
                            <Link aria-label={t('home')} href="/"
                                className="hidden opacity-0 xl:opacity-100 duration-300 mr-auto xl:flex flex-row items-center">
                                <img src={process.env.AVATAR} alt="Avatar" className="w-12 h-12 rounded-2xl border-2" />
                                <div className="flex flex-col justify-center items-start mx-4">
                                    <p className="text-xl font-bold dark:text-white">
                                        {process.env.NAME}
                                    </p>
                                    <p className="text-xs text-neutral-500">
                                        {process.env.DESCRIPTION}
                                    </p>
                                </div>
                            </Link>
                            <div
                                className="w-full md:w-max transition-all duration-500 md:absolute md:left-1/2 md:translate-x-[-50%] flex-row justify-center items-center">
                                <div
                                    className="glass-panel flex flex-row items-center bg-w t-primary rounded-full px-2 shadow-xl shadow-light">
                                    <Link aria-label={t('home')} href="/"
                                        className="visible opacity-100 md:hidden md:opacity-0 duration-300 mr-auto flex flex-row items-center py-2">
                                        <img src={process.env.AVATAR} alt="Avatar"
                                            className="w-10 h-10 rounded-full border-2" />
                                        <div className="flex flex-col justify-center items-start mx-2">
                                            <p className="text-sm font-bold">
                                                {process.env.NAME}
                                            </p>
                                            <p className="text-xs text-neutral-500">
                                                {process.env.DESCRIPTION}
                                            </p>
                                        </div>
                                    </Link>
                                    <NavBar menu={false} />
                                    {children}
                                    <Menu />
                                </div>
                            </div>
                            <div className="ml-auto hidden opacity-0 md:opacity-100 duration-300 md:flex flex-row items-center space-x-2">
                                {isBlog && <SearchButton />}
                                <AppearanceButton profile={profile} />
                                <UserAvatar profile={profile} />
                            </div>
                        </div>
                    </Padding>
                </div>
            </div>
            <div className="h-20"></div>
        </>
    ), [profile, children, isBlog, t])
}

function NavItem({ menu, title, selected, href, when = true, onClick }: {
    title: string,
    selected: boolean,
    href: string,
    menu?: boolean,
    when?: boolean,
    onClick?: () => void
}) {
    return (
        <>
            {when &&
                <Link href={href}
                    className={`${menu ? "" : "hidden"} md:block cursor-pointer hover:text-theme duration-300 px-2 py-4 md:px-2.5 lg:px-4 text-xs lg:text-sm ${selected ? "text-theme" : "dark:text-white"}`}
                    state={{ animate: true }}
                    onClick={onClick}
                >
                    {title}
                </Link>}
        </>
    )
}

function Menu() {
    const profile = useContext(ProfileContext);
    const [isOpen, setOpen] = useState(false)
    const [location] = useLocation()

    function onClose() {
        document.body.style.overflow = "auto"
        setOpen(false)
    }

    return (
        <div className="visible md:hidden flex flex-row items-center">
            <Popup
                arrow={false}
                trigger={<div>
                    <button onClick={() => setOpen(true)}
                        className="w-10 h-10 rounded-full flex flex-row items-center justify-center">
                        <i className="ri-menu-line ri-lg" />
                    </button>
                </div>
                }
                position="bottom right"
                open={isOpen}
                nested
                onOpen={() => document.body.style.overflow = "hidden"}
                onClose={onClose}
                closeOnDocumentClick
                closeOnEscape
                overlayStyle={{ background: "rgba(0,0,0,0.3)" }}
            >
                <div className="flex flex-col bg-w rounded-xl p-2 mt-4 w-[50vw]">
                        <div className="flex flex-row justify-end space-x-2">
                            {location.startsWith('/blog') && <SearchButton onClose={onClose} />}
                            <AppearanceButton profile={profile} onClose={onClose} />
                            <UserAvatar profile={profile} />
                    </div>
                    <NavBar menu={true} onClick={onClose} />
                </div>
            </Popup>
        </div>
    )
}

function AppearanceButton({ profile, onClose }: { profile?: Profile, onClose?: () => void }) {
    if (!profile) return null
    return (
        <Link href="/appearance" onClick={onClose} title="外观设置" aria-label="外观设置"
            className="flex rounded-full border dark:border-neutral-600 px-2 bg-w aspect-[1] items-center justify-center t-primary bg-button">
            <i className="ri-palette-line" />
        </Link>
    )
}

function NavBar({ menu, onClick }: { menu: boolean, onClick?: () => void }) {
    const profile = useContext(ProfileContext);
    const [location] = useLocation();
    const isBlog = location.startsWith('/blog');
    const isLife = location.startsWith('/life');
    const knownBlogSections = ['/blog/articles', '/blog/timeline', '/blog/diary', '/blog/tags', '/blog/gallery', '/blog/writing'];
    const isArticle = location === '/blog/articles' || location.startsWith('/blog/feed/') || location.startsWith('/blog/search/') || (
        location.startsWith('/blog/') && !knownBlogSections.some(path => location === path || location.startsWith(`${path}/`)) && !location.startsWith('/blog/tag/')
    );
    return (
        <>
            {!isBlog && !isLife && <NavItem menu={menu} onClick={onClick} title="首页" selected={location === "/"} href="/" />}
            {isBlog && <>
                <NavItem menu={menu} onClick={onClick} title="Blog 首页" selected={location === '/blog'} href="/blog" />
                <NavItem menu={menu} onClick={onClick} title="文章" selected={isArticle} href="/blog/articles" />
                <NavItem menu={menu} onClick={onClick} title="时间轴" selected={location === '/blog/timeline'} href="/blog/timeline" />
                <NavItem menu={menu} onClick={onClick} title="日记" selected={location === '/blog/diary'} href="/blog/diary" />
                <NavItem menu={menu} onClick={onClick} title="标签" selected={location === '/blog/tags' || location.startsWith('/blog/tag/')} href="/blog/tags" />
                <NavItem menu={menu} onClick={onClick} when={profile?.canWrite === true} title="写作" selected={location.startsWith('/blog/writing')} href="/blog/writing" />
            </>}
            {isLife && <>
                <NavItem menu={menu} onClick={onClick} title="总览" selected={location === '/life'} href="/life" />
                <NavItem menu={menu} onClick={onClick} title="习惯" selected={location === '/life/habits'} href="/life/habits" />
                <NavItem menu={menu} onClick={onClick} title="日历" selected={location === '/life/calendar'} href="/life/calendar" />
                <NavItem menu={menu} onClick={onClick} title="年历" selected={location === '/life/year'} href="/life/year" />
                <NavItem menu={menu} onClick={onClick} title="番茄钟" selected={location === '/life/pomodoro'} href="/life/pomodoro" />
                <NavItem menu={menu} onClick={onClick} title="RSS" selected={location === '/life/rss'} href="/life/rss" />
            </>}
        </>
    )
}

function SearchButton({ className, onClose }: { className?: string, onClose?: () => void }) {
    const { t } = useTranslation()
    const [isOpened, setIsOpened] = useState(false);
    const [_, setLocation] = useLocation()
    const [value, setValue] = useState('')
    const label = t('article.search.title')
    const onSearch = () => {
        const key = `${encodeURIComponent(value)}`
        setTimeout(() => {
            setIsOpened(false)
            if (value.length !== 0)
                onClose?.()
        }, 100)
        if (value.length !== 0)
            setLocation(`/blog/search/${key}`)
    }
    return (<div className={className + " flex flex-row items-center gap-2"}>
        <button onClick={() => setIsOpened(true)} title={label} aria-label={label}
            className="flex rounded-full border dark:border-neutral-600 px-2 bg-w aspect-[1] items-center justify-center t-primary bg-button">
            <i className="ri-search-line"></i>
        </button>
        <ReactModal
            isOpen={isOpened}
            style={{
                content: {
                    top: "20%",
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
            <div className="bg-w w-full flex flex-row items-center justify-between p-4 space-x-4">
                <Input value={value} setValue={setValue} placeholder={t('article.search.placeholder')}
                    autofocus
                    onSubmit={onSearch} />
                <Button title={value.length === 0 ? t("close") : label} onClick={onSearch} />
            </div>
        </ReactModal>
    </div>
    )
}

function LocalClock() {
    const [now, setNow] = useState(new Date());
    useEffect(() => {
        let timer = 0;
        const schedule = () => { const delay = 60000 - (Date.now() % 60000) + 50; timer = window.setTimeout(() => { setNow(new Date()); schedule(); }, delay); };
        schedule(); return () => window.clearTimeout(timer);
    }, []);
    return <time className="header-clock" dateTime={now.toISOString()}>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>;
}


function UserAvatar({ className, profile, onClose }: { className?: string, profile?: Profile, onClose?: () => void }) {
    const { t } = useTranslation()
    const { LoginModal, setIsOpened } = useLoginModal(onClose)
    const label = t('github_login')

    return (<div className={className + " flex flex-row items-center gap-2"}>
        {profile && <LocalClock />}
        {profile?.avatar ? <>
            <div className="w-8 relative">
                <img src={profile.avatar} alt="Avatar" className="w-8 h-8 rounded-full border" />
                <div className="z-50 absolute left-0 top-0 w-10 h-8 opacity-0 hover:opacity-100 duration-300">
                    <IconSmall label={t('logout')} name="ri-logout-circle-line" onClick={() => {
                        removeCookie("token")
                        localStorage.removeItem('shjdshy-life-profile')
                        window.location.reload()
                    }} hover={false} />
                </div>
            </div>
        </> : <>
            <button onClick={() => setIsOpened(true)} title={label} aria-label={label}
                className="flex rounded-full border dark:border-neutral-600 px-2 bg-w aspect-[1] items-center justify-center t-primary bg-button">
                <i className="ri-user-received-line"></i>
            </button>
        </>}
        <LoginModal />
    </div>
    )
}
