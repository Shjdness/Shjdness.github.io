import { useContext, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { ProfileContext } from '../state/profile';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';

type LifeSection = 'life' | 'habits' | 'calendar' | 'year' | 'rss';

const pages: Array<{ id: Exclude<LifeSection, 'life'>; title: string; description: string; href: string; icon: string }> = [
  { id: 'habits', title: '习惯', description: '记录希望长期留在生活里的事。', href: '/habits', icon: 'ri-seedling-line' },
  { id: 'calendar', title: '日历', description: '把每日记录与习惯放在同一条生活轨迹中。', href: '/calendar', icon: 'ri-calendar-2-line' },
  { id: 'year', title: '年历', description: '以安静的方式看见这一年的生活痕迹。', href: '/year', icon: 'ri-calendar-check-line' },
  { id: 'rss', title: 'RSS', description: '私人的信息与阅读入口。', href: '/rss', icon: 'ri-rss-line' },
];

function mayAccessLife(role: string | undefined) {
  return role === 'owner' || role === 'trusted';
}

export function PrivateLifePage({ section }: { section: LifeSection }) {
  const profile = useContext(ProfileContext);
  const [verified, setVerified] = useState(false);
  const [denied, setDenied] = useState(false);
  const sectionInfo = pages.find(page => page.id === section);

  useEffect(() => {
    if (!mayAccessLife(profile?.role)) {
      setVerified(false);
      return;
    }
    client.life.overview.get({ headers: headersWithAuth() }).then(({ data, error }) => {
      setDenied(Boolean(error) || !data || typeof data === 'string');
      setVerified(Boolean(data) && typeof data !== 'string');
    });
  }, [profile?.id, profile?.role]);

  if (!mayAccessLife(profile?.role) || denied) {
    return (
      <main className="life-page">
        <section className="life-panel life-denied">
          <p className="life-kicker">PRIVATE LIFE</p>
          <h1>这里是私人生活空间</h1>
          <p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p>
          <Link className="life-link" href="/">返回公开首页</Link>
        </section>
      </main>
    );
  }

  if (!verified) {
    return <main className="life-page"><section className="life-panel"><p className="life-kicker">PRIVATE LIFE</p><p>正在确认访问权限…</p></section></main>;
  }

  if (sectionInfo) {
    return (
      <main className="life-page">
        <Helmet><title>{sectionInfo.title} - {process.env.NAME}</title></Helmet>
        <section className="life-panel life-section">
          <Link className="life-back" href="/life"><i className="ri-arrow-left-line" /> 返回 Life</Link>
          <p className="life-kicker">PRIVATE LIFE</p>
          <h1>{sectionInfo.title}</h1>
          <p>{sectionInfo.description}</p>
          <div className="life-coming-soon">这一入口已受后端权限保护。对应的数据功能将在下一小阶段接入。</div>
        </section>
      </main>
    );
  }

  return (
    <main className="life-page">
      <Helmet><title>Life - {process.env.NAME}</title></Helmet>
      <section className="life-panel">
        <p className="life-kicker">PRIVATE LIFE</p>
        <h1>Life</h1>
        <p className="life-intro">这是只属于生活的安静空间。每个入口都经过服务端权限验证，后续数据也会按账号归属保存。</p>
        <div className="life-grid">
          {pages.map(page => <Link className="life-card" href={page.href} key={page.id}>
            <i className={page.icon} />
            <span><strong>{page.title}</strong><small>{page.description}</small></span>
            <i className="ri-arrow-right-up-line" />
          </Link>)}
        </div>
      </section>
    </main>
  );
}
