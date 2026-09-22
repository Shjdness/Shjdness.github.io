import { useEffect, useMemo, useRef, useState } from 'react'
import { Helmet } from 'react-helmet'
import { getCookie } from 'typescript-cookie'
import { DefaultParams, PathPattern, Redirect, Route, Switch, useLocation } from 'wouter'
import Footer from './components/footer'
import { Header } from './components/header'
import { Padding } from './components/padding'
import useTableOfContents from './hooks/useTableOfContents.tsx'
import { client } from './main'
import { CallbackPage } from './page/callback'
import { FeedPage, TOCHeader } from './page/feed'
import { FeedsPage } from './page/feeds'
import { GalleryPage } from './page/gallery'
import { HashtagPage } from './page/hashtag.tsx'
import { HashtagsPage } from './page/hashtags.tsx'
import { TimelinePage } from './page/timeline'
import { WritingPage } from './page/writing'
import { ClientConfigContext, ConfigWrapper, defaultClientConfig } from './state/config.tsx'
import { Profile, ProfileContext } from './state/profile'
import { headersWithAuth } from './utils/auth'
import { tryInt } from './utils/int'
import { SearchPage } from './page/search.tsx'
import { Tips, TipsPage } from './components/tips.tsx'
import { useTranslation } from 'react-i18next'
import { AppearanceContext, AppearanceSettings, DEFAULT_APPEARANCE, mergeAppearance } from './state/appearance.tsx'
import { AppearancePage } from './page/appearance.tsx'
import { PrivateLifePage } from './page/life.tsx'
import { HomePage } from './page/home.tsx'
import { BlogHomePage } from './page/blog_home.tsx'
import { DiaryPage } from './page/diary.tsx'
import { GuidePage } from './page/guide.tsx'

const LIFE_PROFILE_CACHE = 'shjdshy-life-profile';
const cachedProfile = () => {
  if (!(getCookie('token')?.length ?? 0)) return undefined;
  try { return JSON.parse(localStorage.getItem(LIFE_PROFILE_CACHE) || 'null') as Profile | undefined; } catch { return undefined; }
};

function App() {
  const ref = useRef(false)
  const { t } = useTranslation()
  const [location] = useLocation()
  const [profile, setProfile] = useState<Profile | undefined>(cachedProfile)
  const [config, setConfig] = useState<ConfigWrapper>(new ConfigWrapper({}, new Map()))
  const [appearanceDefaults, setAppearanceDefaults] = useState<AppearanceSettings>(DEFAULT_APPEARANCE)
  const [personalAppearance, setPersonalAppearance] = useState<AppearanceSettings | null>(null)
  const [appearancePreview, setAppearancePreview] = useState<AppearanceSettings | null>(null)
  useEffect(() => {
    if (ref.current) return
    if (getCookie('token')?.length ?? 0 > 0) {
      client.user.profile.get({
        headers: headersWithAuth()
      }).then(({ data }) => {
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
  useEffect(() => {
    client.appearance.default.get().then(({ data }) => {
      if (data && typeof data !== 'string') {
        setAppearanceDefaults(data.settings)
      }
    })
  }, [])
  useEffect(() => {
    if (!profile) {
      setPersonalAppearance(null)
      setAppearancePreview(null)
      return
    }
    client.appearance.index.get({ headers: headersWithAuth() }).then(({ data }) => {
      if (data && typeof data !== 'string') {
        setPersonalAppearance(data.settings)
        setAppearancePreview(null)
      }
    })
  }, [profile?.id])
  const favicon = useMemo(() => config.get<string>("favicon"), [config])
  const appearance = appearancePreview || mergeAppearance(appearanceDefaults, personalAppearance)
  const appearanceStyle = useMemo(() => ({
    '--background-blur': `${appearance.backgroundBlur}px`,
    '--background-brightness': String(appearance.backgroundBrightness),
    '--background-saturation': String(appearance.backgroundSaturation),
    '--glass-opacity': String(appearance.glassOpacity),
    '--glass-blur': `${appearance.glassBlur}px`,
  } as React.CSSProperties), [appearance])
  return (
    <div className={`site-shell ${location === '/' ? 'site-shell--home' : location.startsWith('/life') ? 'site-shell--life' : 'site-shell--blog'}`} style={appearanceStyle}>
      <ClientConfigContext.Provider value={config}>
        <ProfileContext.Provider value={profile}>
          <AppearanceContext.Provider value={{
            settings: appearance,
            defaults: appearanceDefaults,
            setPreview: setAppearancePreview,
            savePersonal: (settings) => {
              setPersonalAppearance(settings)
              setAppearancePreview(null)
            },
            saveDefaults: (settings) => {
              setAppearanceDefaults(settings)
              setAppearancePreview(null)
            },
            clearPersonal: () => {
              setPersonalAppearance(null)
              setAppearancePreview(null)
            },
          }}>
            <Helmet>
              {favicon &&
                <link rel="icon" href={favicon} />}
            </Helmet>
            <Switch>
            <Route path="/"><HomePage /></Route>

            <RouteMe path="/blog"><BlogHomePage /></RouteMe>
            <RouteMe path="/blog/articles"><FeedsPage /></RouteMe>
            <RouteMe path="/blog/timeline"><TimelinePage /></RouteMe>
            <RouteMe path="/blog/diary"><DiaryPage /></RouteMe>
            <RouteMe path="/blog/tags"><HashtagsPage /></RouteMe>
            <RouteMe path="/blog/gallery"><GalleryPage /></RouteMe>
            <RouteMe path="/blog/tag/:name">
              {params => decodeURIComponent(params.name || '') === '日记' ? <Redirect to="/blog/diary" /> : <HashtagPage name={params.name || ""} />}
            </RouteMe>
            <RouteMe path="/blog/search/:keyword">
              {params => <SearchPage keyword={params.keyword || ""} />}
            </RouteMe>
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
            <Route path="/hashtags"><Redirect to="/blog/tags" /></Route>

            <Route path="/gallery"><Redirect to="/blog/gallery" /></Route>

            <Route path="/hashtag/:name">{params => <Redirect to={`/blog/tag/${params.name || ''}`} />}</Route>
            <Route path="/search/:keyword">{params => <Redirect to={`/blog/search/${params.keyword || ''}`} />}</Route>
            <Route path="/writing"><Redirect to="/blog/writing" /></Route>
            <Route path="/writing/:id">{params => <Redirect to={`/blog/writing/${params.id || ''}`} />}</Route>

            <RouteMe path="/appearance" paddingClassName='mx-4'>
              <AppearancePage />
            </RouteMe>

            <RouteMe path="/life" paddingClassName='mx-4'>
              <PrivateLifePage section="life" />
            </RouteMe>

            <RouteMe path="/life/habits" paddingClassName='mx-4'><PrivateLifePage section="habits" /></RouteMe>
            <RouteMe path="/life/calendar" paddingClassName='mx-4'><PrivateLifePage section="calendar" /></RouteMe>
            <RouteMe path="/life/year" paddingClassName='mx-4'><PrivateLifePage section="year" /></RouteMe>
            <RouteMe path="/life/pomodoro" paddingClassName='mx-4'><PrivateLifePage section="pomodoro" /></RouteMe>
            <RouteMe path="/life/rss" paddingClassName='mx-4'><PrivateLifePage section="rss" /></RouteMe>
            <RouteMe path="/life/guide" paddingClassName='mx-4'><GuidePage /></RouteMe>

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
          </AppearanceContext.Provider>
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
