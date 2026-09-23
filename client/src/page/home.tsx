import { Helmet } from 'react-helmet';
import { Link } from 'wouter';

export function HomePage() {
  return (
    <main className="home-landing">
      <Helmet><title>{process.env.NAME}</title></Helmet>
      <section className="home-landing-card">
        <img className="home-avatar" src="/avatar.jpg" alt={`${process.env.NAME} 的头像`} />
        <p className="home-kicker">WELCOME TO MY GARDEN</p>
        <h1>{process.env.NAME}</h1>
        <p className="home-motto">{process.env.DESCRIPTION}</p>
        <p className="home-intro">这里收藏文字，也安放生活。愿每一次到访，都能在花园里找到片刻安静。</p>
        <nav className="home-portals" aria-label="网站空间">
          <Link href="/blog"><span><small>PUBLIC WRITING</small><strong>Blog</strong></span><i className="ri-arrow-right-line" /></Link>
          <Link href="/life"><span><small>PRIVATE SPACE</small><strong>Life</strong></span><i className="ri-arrow-right-line" /></Link>
        </nav>
      </section>
    </main>
  );
}
