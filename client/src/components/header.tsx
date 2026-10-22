import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Popup from "reactjs-popup";
import { removeCookie } from "typescript-cookie";
import { Link, useLocation } from "wouter";
import { useLoginModal } from "../hooks/useLoginModal";
import { Profile, ProfileContext } from "../state/profile";
import { IconSmall } from "./icon";
import { Padding } from "./padding";
import { usePomodoro } from "../state/pomodoro";


export function Header({ children }: { children?: React.ReactNode }) {
    const profile = useContext(ProfileContext);
    const { t } = useTranslation()

    return useMemo(() => (
        <>
            <div className="site-header fixed z-40">
                <div className="w-screen">
                    <Padding className="mx-4 mt-4">
                        <div className="site-header-row">
                            <div className="site-header-brand">
                            <Link aria-label={t('home')} href="/"
                                className="flex flex-row items-center">
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
                            <SpaceSwitch />
                            </div>
                            <div className="site-header-main">
                                <div
                                    className="site-header-pill glass-panel bg-w t-primary rounded-full shadow-xl shadow-light">
                                    <Link aria-label={t('home')} href="/"
                                        className="site-header-compact-home">
                                        <img src={process.env.AVATAR} alt="Avatar"
                                            className="w-10 h-10 rounded-full border-2" />
                                        <div className="site-header-compact-copy">
                                            <p className="text-sm font-bold">
                                                {process.env.NAME}
                                            </p>
                                            <p className="text-xs text-neutral-500">
                                                {process.env.DESCRIPTION}
                                            </p>
                                        </div>
                                    </Link>
                                    <div className="site-header-compact-switch"><SpaceSwitch /></div>
                                    <nav className="site-header-desktop-nav" aria-label="栏目"><NavBar menu={false} /></nav>
                                    {children}
                                    <Menu />
                                </div>
                            </div>
                            <div className="site-header-actions">
                                <AppearanceButton profile={profile} />
                                <UserAvatar profile={profile} />
                            </div>
                        </div>
                    </Padding>
                </div>
            </div>
            <div className="h-20"></div>
        </>
    ), [profile, children, t])
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
                    className={`${menu ? "site-menu-link" : "site-desktop-link"} cursor-pointer hover:text-theme duration-300 ${selected ? "text-theme" : "dark:text-white"}`}
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

    function onClose() {
        document.body.style.overflow = "auto"
        setOpen(false)
    }

    return (
        <div className="site-header-menu">
            <Popup
                arrow={false}
                trigger={<div>
                    <button onClick={() => setOpen(true)} aria-label="打开栏目菜单" aria-expanded={isOpen}
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
                <div className="site-header-popover flex flex-col bg-w rounded-xl p-2 mt-4">
                        <div className="flex flex-row justify-end space-x-2">
                            <AppearanceButton profile={profile} onClose={onClose} />
                            <UserAvatar profile={profile} />
                    </div>
                    <SpaceSwitch onClick={onClose} />
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

export function SpaceSwitch({ onClick }: { onClick?: () => void }) {
    const [location] = useLocation();
    return <nav className="space-switch" aria-label="网站空间">
        <Link href="/blog" aria-current={location.startsWith('/blog') ? 'page' : undefined} onClick={onClick}>Blog</Link>
        <Link href="/life" aria-current={location.startsWith('/life') ? 'page' : undefined} onClick={onClick}>Life</Link>
    </nav>;
}

function NavBar({ menu, onClick }: { menu: boolean, onClick?: () => void }) {
    const profile = useContext(ProfileContext);
    const [location] = useLocation();
    const isBlog = location.startsWith('/blog');
    const isLife = location.startsWith('/life');
    const knownBlogSections = ['/blog/articles', '/blog/timeline', '/blog/diary', '/blog/memos', '/blog/drafts', '/blog/gallery', '/blog/writing'];
    const isArticle = location === '/blog/articles' || location.startsWith('/blog/feed/') || (
        location.startsWith('/blog/') && !knownBlogSections.some(path => location === path || location.startsWith(`${path}/`)) && !location.startsWith('/blog/tag/')
    );
    return (
        <>
            {!isBlog && !isLife && <NavItem menu={menu} onClick={onClick} title="首页" selected={location === "/"} href="/" />}
            {isBlog && <>
                <NavItem menu={menu} onClick={onClick} title="Blog 首页" selected={location === '/blog'} href="/blog" />
                <NavItem menu={menu} onClick={onClick} title="文章" selected={isArticle} href="/blog/articles" />
                <NavItem menu={menu} onClick={onClick} title="日记" selected={location === '/blog/diary'} href="/blog/diary" />
                <NavItem menu={menu} onClick={onClick} when={profile?.canWrite === true} title="备忘录" selected={location === '/blog/memos'} href="/blog/memos" />
                <NavItem menu={menu} onClick={onClick} when={profile?.canWrite === true} title="草稿" selected={location === '/blog/drafts'} href="/blog/drafts" />
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

function LocalClock() {
    const { timer, running, clock } = usePomodoro();
    const [now, setNow] = useState(new Date());
    useEffect(() => {
        let timer = 0;
        const schedule = () => { const delay = 60000 - (Date.now() % 60000) + 50; timer = window.setTimeout(() => { setNow(new Date()); schedule(); }, delay); };
        const refresh = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
        schedule(); document.addEventListener('visibilitychange', refresh);
        return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
    }, []);
    const date = now.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (running) return <Link href="/life/pomodoro" className="header-clock header-pomodoro" title={`打开番茄钟：${timer.taskName.trim() || '未命名任务'}，剩余 ${clock}`}><span className="header-date">{date}</span><span className="header-time">{time}</span><span className="header-task">{timer.taskName.trim() || '专注'}</span><span className="header-countdown">{clock}</span></Link>;
    return <time className="header-clock" dateTime={now.toISOString()}><span className="header-date">{date}</span><span className="header-time">{time}</span></time>;
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
