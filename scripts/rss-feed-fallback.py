"""Bounded daily metadata fallback for unavailable official feeds only."""
import importlib.util
import json
import os
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('rss_history', Path(__file__).with_name('rss-history.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)

def main():
    failed_ids = set(json.loads(Path(os.environ['RSS_SYNC_FAILURE_FILE']).read_text(encoding='utf-8')))
    if not failed_ids:
        print('Metadata fallback: no failed feeds')
        return
    sources = history.api('/sync/history-sources')['sources']
    failed = 0
    for source in sources:
        if source['id'] not in failed_ids:
            continue
        try:
            channel = history.recover_channel(source)
            if not channel:
                raise RuntimeError('Invalid channel ID')
            videos = {}
            accessible = False
            opts = {'extract_flat': True, 'lazy_playlist': True, 'skip_download': True,
                    'quiet': True, 'logger': history.QuietLogger(), 'socket_timeout':25,
                    'retries':2, 'extractor_retries':2, 'playlistend':15,
                    'extractor_args':{'youtubetab':{'approximate_date':['true']}}}
            with history.YoutubeDL(opts) as ydl:
                for tab in ['videos','streams']:
                    try:
                        listing = ydl.extract_info(f'https://www.youtube.com/channel/{channel}/{tab}',download=False)
                    except Exception as error:
                        if any(text in str(error).lower() for text in ['does not have a', 'no uploads']):
                            continue
                        raise
                    accessible = True
                    for entry in listing.get('entries') or []:
                        if not entry or entry.get('live_status') in ['is_live','is_upcoming'] or entry.get('is_live'):
                            continue
                        identity = entry.get('id') or ''
                        title = str(entry.get('title') or '').strip()
                        if not history.VIDEO_ID.fullmatch(identity) or not title or title in ['[Private video]','[Deleted video]']:
                            continue
                        timestamp = entry.get('release_timestamp') or entry.get('timestamp') or 0
                        if source.get('policy') == 'two-years' and timestamp and timestamp < time.time()-(2*365+45)*86400:
                            continue
                        videos[identity] = {'externalId':identity,'title':title[:500],
                            'summary':str(entry.get('description') or '')[:4000],
                            'publishedAt':max(0,int(timestamp)),
                            'publishedPrecision':'exact' if entry.get('release_timestamp') else 'estimated' if timestamp else 'unknown'}
            if not accessible:
                raise RuntimeError('No accessible recent metadata')
            result = history.api('/sync/history-batch',{'subscriptionId':source['id'],'videos':list(videos.values())})
            # A successful bounded fallback does not mark historical coverage complete.
            history.api('/sync/error',{'subscriptionId':source['id'],'error':''})
            print(f"FALLBACK source={source['id']} added={result['added']} changed={result['updated']} skipped={result['unchanged']}",flush=True)
        except Exception:
            failed += 1
            history.api('/sync/error',{'subscriptionId':source['id'],'error':'官方 Feed 与公开目录均暂不可用；保留已有内容，下次每日同步重试'})
            print(f"FALLBACK source={source['id']} status=failed",flush=True)
    print(f'Metadata fallback: {len(failed_ids)-failed} recovered, {failed} failed',flush=True)
    if failed:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
