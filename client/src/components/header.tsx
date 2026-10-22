import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { removeCookie } from "typescript-cookie";
import { Link, useLocation } from "wouter";
import { useLoginModal } from "../hooks/useLoginModal";
import { Profile, ProfileContext } from "../state/profile";
import { IconSmall } from "./icon";
import { Padding } from "./padding";
import { usePomodoro } from "../state/pomodoro";


export function Header({ children }: { children?: React.ReactNode }) {
    const profile = useContext(ProfileContext);
    const { t } = useTranslation();
    return <>
        <div className="site-header fixed z-40">
            <Padding className="mx-4 mt-4">
                <div className="site-header-row glass-panel">
                    <div className="site-header-identity">
                        <Link href="/" aria-label={t("home")} className="site-header-home">
                            <img src={process.env.AVATAR || "/avatar.jpg"} alt="" />
                            <span><strong>{process.env.NAME}</strong><small>{process.env.DESCRIPTION}</small></span>
                        </Link>
                        <SpaceSwitch />
                    </div>
                    <nav className="site-header-nav" aria-label="页面栏目"><NavBar /></nav>
                    <div className="site-header-actions"><UserAvatar profile={profile} />{children}</div>
                </div>
            </Padding>
        </div>
        <div className="site-header-spacer" />
    </>;
}

function NavItem({ title, selected, href, when = true }: { title: string; selected: boolean; href: string; when?: boolean }) {
    return when ? <Link href={href} aria-current={selected ? "page" : undefined} className="site-nav-link">{title}</Link> : null;
}

export function SpaceSwitch({ onClick }: { onClick?: () => void }) {
    const [location] = useLocation();
    return <nav className="space-switch" aria-label="网站空间">
        <Link href="/blog" aria-current={location.startsWith('/blog') ? 'page' : undefined} onClick={onClick}>Blog</Link>
        <Link href="/life" aria-current={location.startsWith('/life') ? 'page' : undefined} onClick={onClick}>Life</Link>
    </nav>;
}

function NavBar() {
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
            {!isBlog && !isLife && <NavItem title="首页" selected={location === "/"} href="/" />}
            {isBlog && <>
                <NavItem title="Blog 首页" selected={location === '/blog'} href="/blog" />
                <NavItem title="文章" selected={isArticle} href="/blog/articles" />
                <NavItem title="日记" selected={location === '/blog/diary'} href="/blog/diary" />
                <NavItem when={profile?.canWrite === true} title="备忘录" selected={location === '/blog/memos'} href="/blog/memos" />
                <NavItem when={profile?.canWrite === true} title="草稿" selected={location === '/blog/drafts'} href="/blog/drafts" />
                <NavItem when={profile?.canWrite === true} title="写作" selected={location.startsWith('/blog/writing')} href="/blog/writing" />
            </>}
            {isLife && <>
                <NavItem title="总览" selected={location === '/life'} href="/life" />
                <NavItem title="待办" selected={location === "/life/todos"} href="/life/todos" />
                <NavItem title="习惯" selected={location === '/life/habits'} href="/life/habits" />
                <NavItem title="日历" selected={location === '/life/calendar'} href="/life/calendar" />
                <NavItem title="年历" selected={location === '/life/year'} href="/life/year" />
                <NavItem title="番茄钟" selected={location === '/life/pomodoro'} href="/life/pomodoro" />
                <NavItem title="RSS" selected={location === '/life/rss'} href="/life/rss" />
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
