import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Helmet } from 'react-helmet'
import { getCookie, removeCookie } from 'typescript-cookie'
import { DefaultParams, PathPattern, Redirect, Route, Switch, useLocation } from 'wouter'
import Footer from './components/footer'
import { Header } from './components/header'
import { Padding } from './components/padding'
import useTableOfContents from './hooks/useTableOfContents.tsx'
import { client } from './main'
import { CallbackPage } from './page/callback'
import { TOCHeader } from './components/toc-header'
import { FeedsPage } from './page/feeds'
import { TimelinePage } from './page/timeline'
import { ClientConfigContext, ConfigWrapper, defaultClientConfig } from './state/config.tsx'
import { Profile, ProfileContext } from './state/profile'
import { headersWithAuth } from './utils/auth'
import { tryInt } from './utils/int'
import { Tips, TipsPage } from './components/tips.tsx'
import { useTranslation } from 'react-i18next'
import { HomePage } from './page/home.tsx'
import { BlogHomePage } from './page/blog_home.tsx'
import { DiaryPage } from './page/diary.tsx'
import { MemoPage } from './page/memo.tsx'
import { PomodoroProvider } from './state/pomodoro.tsx'
import { accountIdFromToken } from './data/local-first'

const GalleryPage = lazy(() => import('./page/gallery').then(module => ({ default: module.GalleryPage })))
const FeedPage = lazy(() => import('./page/feed').then(module => ({ default: module.FeedPage })))
const WritingPage = lazy(() => import('./page/writing').then(module => ({ default: module.WritingPage })))
const PrivateLifePage = lazy(() => import('./page/life.tsx').then(module => ({ default: module.PrivateLifePage })))

const LIFE_PROFILE_CACHE = 'shjdshy-life-profile';
const cachedProfile = () => {
  const accountId = accountIdFromToken(getCookie('token'));
  if (!accountId) return undefined;
  try {
    const cached = JSON.parse(localStorage.getItem(LIFE_PROFILE_CACHE) || 'null') as Profile | undefined;
    return cached?.id === accountId ? cached : undefined;
  } catch { return undefined; }
};

function App() {
  const ref = useRef(false)
  const { t } = useTranslation()
  const [location] = useLocation()
  const [profile, setProfile] = useState<Profile | undefined>(cachedProfile)
  const [config, setConfig] = useState<ConfigWrapper>(new ConfigWrapper({}, new Map()))
  useEffect(() => {
    if (ref.current) return
    if (getCookie('token')?.length ?? 0 > 0) {
      client.user.profile.get({
        headers: headersWithAuth()
      }).then(({ data, error }) => {
        if (data && typeof data !== 'string') {
          const nextProfile: Profile = {
            id: data.id,
            avatar: data.avatar || '',
            permission: data.permission,
            canWrite: data.canWrite,
            role: data.role === 'owner' || data.role === 'trusted' ? data.role : 'member',
            name: data.username
          };
          setProfile(nextProfile)
          localStorage.setItem(LIFE_PROFILE_CACHE, JSON.stringify(nextProfile))
        } else if (error?.status === 401 || error?.status === 403) {
          removeCookie('token')
          localStorage.removeItem(LIFE_PROFILE_CACHE)
          setProfile(undefined)
        }
      })
    }
    const config = sessionStorage.getItem('config')
    if (config) {
      const configObj = JSON.parse(config)
      const configWrapper = new ConfigWrapper(configObj, defaultClientConfig)
      setConfig(configWrapper)
    } else {
      client.config({ type: "client" }).get().then(({ data }) => {
        if (data && typeof data !== 'string') {
          sessionStorage.setItem('config', JSON.stringify(data))
          const config = new ConfigWrapper(data, defaultClientConfig)
          setConfig(config)
        }
      })
    }
    ref.current = true
  }, [])
  const favicon = useMemo(() => config.get<string>("favicon"), [config])
  const pomodoroOwnerId = accountIdFromToken(getCookie('token')) === profile?.id ? profile.id : null
  return (
    <div className={`site-shell ${location === '/' ? 'site-shell--home' : location.startsWith('/life') ? 'site-shell--life' : 'site-shell--blog'}`}>
      <ClientConfigContext.Provider value={config}>
        <ProfileContext.Provider value={profile}>
          <PomodoroProvider key={pomodoroOwnerId ?? 'anonymous'} ownerId={pomodoroOwnerId}>
            <Helmet>
              {favicon &&
                <link rel="icon" href={favicon} />}
            </Helmet>
            <Suspense fallback={<div className="route-loading" role="status">正在打开…</div>}>
            <Switch>
            <Route path="/"><HomePage /></Route>

            <RouteMe path="/blog"><BlogHomePage /></RouteMe>
            <RouteMe path="/blog/articles"><FeedsPage /></RouteMe>
            <RouteMe path="/blog/drafts"><FeedsPage fixedType="draft" /></RouteMe>
            <RouteMe path="/blog/timeline"><TimelinePage /></RouteMe>
            <RouteMe path="/blog/diary"><DiaryPage /></RouteMe>
            <RouteMe path="/blog/memos"><MemoPage /></RouteMe>
            <RouteMe path="/blog/gallery"><GalleryPage /></RouteMe>
            <RouteMe path="/blog/writing" paddingClassName='mx-4'>
              <WritingPage />
            </RouteMe>
            <RouteMe path="/blog/writing/:id" paddingClassName='mx-4'>
              {({ id }) => <WritingPage id={tryInt(0, id)} />}
            </RouteMe>
            <RouteWithIndex path="/blog/feed/:id">
              {(params, TOC, clean) => <FeedPage id={params.id || ""} TOC={TOC} clean={clean} />}
            </RouteWithIndex>
            <RouteWithIndex path="/blog/:alias">
              {(params, TOC, clean) => <FeedPage id={params.alias || ""} TOC={TOC} clean={clean} />}
            </RouteWithIndex>

            <Route path="/timeline"><Redirect to="/blog/timeline" /></Route>
            <Route path="/hashtags"><Redirect to="/blog/timeline" /></Route>

            <Route path="/gallery"><Redirect to="/blog/gallery" /></Route>

            <Route path="/hashtag/:name"><Redirect to="/blog/timeline" /></Route>
            <Route path="/writing"><Redirect to="/blog/writing" /></Route>
            <Route path="/writing/:id">{params => <Redirect to={`/blog/writing/${params.id || ''}`} />}</Route>

            <Route path="/appearance"><Redirect to="/life" /></Route>

            <RouteMe path="/life" paddingClassName='mx-4'>
              <PrivateLifePage section="life" />
            </RouteMe>

            <RouteMe path="/life/habits" paddingClassName='mx-4'><PrivateLifePage section="habits" /></RouteMe>
            <RouteMe path="/life/todos" paddingClassName='mx-4'><PrivateLifePage section="todos" /></RouteMe>
            <RouteMe path="/life/calendar" paddingClassName='mx-4'><PrivateLifePage section="calendar" /></RouteMe>
            <RouteMe path="/life/year" paddingClassName='mx-4'><PrivateLifePage section="year" /></RouteMe>
            <RouteMe path="/life/pomodoro" paddingClassName='mx-4'><PrivateLifePage section="pomodoro" /></RouteMe>
            <Route path="/life/rss"><PrivateLifePage section="rss" /></Route>

            <Route path="/habits"><Redirect to="/life/habits" /></Route>
            <Route path="/calendar"><Redirect to="/life/calendar" /></Route>
            <Route path="/year"><Redirect to="/life/year" /></Route>
            <Route path="/rss"><Redirect to="/life/rss" /></Route>

            <RouteMe path="/callback" >
              <CallbackPage />
            </RouteMe>

            <Route path="/feed/:id">{params => <Redirect to={`/blog/feed/${params.id || ''}`} />}</Route>
            <Route path="/:alias">{params => <Redirect to={`/blog/${params.alias || ''}`} />}</Route>

            <RouteMe path="/user/github">
              {_ => (
                <TipsPage>
                  <Tips value={t('error.api_url')} type='error' />
                </TipsPage>
              )}
            </RouteMe>

            <RouteMe path="/*/user/github">
              {_ => (
                <TipsPage>
                  <Tips value={t('error.api_url_slash')} type='error' />
                </TipsPage>
              )}
            </RouteMe>

            <RouteMe path="/user/github/callback">
              {_ => (
                <TipsPage>
                  <Tips value={t('error.github_callback')} type='error' />
                </TipsPage>
              )}
            </RouteMe>

            {/* Default route in a switch */}
            <Route>404: No such page!</Route>
            </Switch>
            </Suspense>
          </PomodoroProvider>
        </ProfileContext.Provider>
      </ClientConfigContext.Provider>
    </div>
  )
}

function RouteMe({ path, children, headerComponent, paddingClassName }:
  { path: PathPattern, children: React.ReactNode | ((params: DefaultParams) => React.ReactNode), headerComponent?: React.ReactNode, paddingClassName?: string }) {
  return (
    <Route path={path} >
      {params => {
        return (<>
          <Header>
            {headerComponent}
          </Header>
          <Padding className={paddingClassName}>
            {typeof children === 'function' ? children(params) : children}
          </Padding>
          <Footer />
        </>)
      }}
    </Route>
  )
}


function RouteWithIndex({ path, children }:
  { path: PathPattern, children: (params: DefaultParams, TOC: () => JSX.Element, clean: (id: string) => void) => React.ReactNode }) {
  const { TOC, cleanup } = useTableOfContents(".toc-content");
  return (<RouteMe path={path} headerComponent={TOCHeader({ TOC: TOC })} paddingClassName='mx-4'>
    {params => {
      return children(params, TOC, cleanup)
    }}
  </RouteMe>)
}

export default App
