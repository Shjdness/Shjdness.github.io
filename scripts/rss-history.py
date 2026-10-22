"""Metadata-only, resumable history import. No browser cookies, audio or video.
Private reports stay in the application database; public CI logs use source IDs.
"""
import datetime as dt
import json
import os
import re
import time
import urllib.request
from pathlib import Path
from yt_dlp import YoutubeDL
from rss_history_policy import classify

ENDPOINT = (os.environ.get('RSS_SYNC_ENDPOINT') or 'https://rin-server.1322589722.workers.dev').rstrip('/')
TOKEN = os.environ['RSS_SYNC_TOKEN']
MAX_BYTES = int(os.environ.get('RSS_HISTORY_MAX_DATABASE_BYTES', 350 * 1024 * 1024))
MAX_ITEMS = int(os.environ.get('RSS_HISTORY_MAX_ITEMS', 20000))
MAX_TOTAL = int(os.environ.get('RSS_HISTORY_MAX_TOTAL', 30000))
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')

def api(path, body=None):
    payload = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(ENDPOINT + '/rss' + path, data=payload, headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except Exception:
            if attempt == 3:
                raise RuntimeError(f'API request failed: {path}') from None
            time.sleep(2 * (attempt + 1))

def state(source, policy, reason, status, error=''):
    return api('/sync/history-state', {'subscriptionId': source['id'], 'policy': policy, 'reason': reason, 'status': status, 'error': error[:400]})

class QuietLogger:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass

def main():
    before = api('/sync/report')
    if not before['backend'].get('measured'):
        raise RuntimeError('无法取得 D1 实际容量，本轮补录停止，避免失去容量保护')
    sources = api('/sync/history-sources')['sources']
    completed, failed, partial, total = 0, 0, 0, 0
    decisions = [(source, *classify(source)) for source in sources if source.get('status') != 'complete']
    decisions.sort(key=lambda entry: (entry[1] != 'full', entry[0]['id']))
    report = {'before': before, 'sources': []}
    try:
        for source, policy, reason in decisions:
            if total >= MAX_TOTAL or before['backend']['usedBytes'] >= MAX_BYTES:
                break
            channel = source.get('channelId') or ''
            if not re.fullmatch(r'UC[A-Za-z0-9_-]{20,}', channel):
                state(source, policy, reason, 'failed', '无有效频道ID，需要修正来源')
                failed += 1
                continue
            state(source, policy, reason, 'running')
            stats = {'id': source['id'], 'policy': policy, 'reason': reason, 'added': 0, 'updated': 0, 'unchanged': 0, 'rowsRead': 0, 'rowsWritten': 0}
            cutoff = time.time() - (2 * 365 + 45) * 86400  # Inclusive margin for relative dates.
            seen = set()
            full = True
            batch = []
            def flush():
                nonlocal total
                if not batch: return
                result = api('/sync/history-batch', {'subscriptionId': source['id'], 'videos': batch})
                for key in ['added', 'updated', 'unchanged', 'rowsRead', 'rowsWritten']:
                    stats[key] += result.get(key, 0)
                total += len(batch)
                batch.clear()
                if result.get('sizeAfter', 0) >= MAX_BYTES or total >= MAX_TOTAL:
                    raise RuntimeError('已达到本轮容量/条数保护阈值，保留进度，下次可继续')
            try:
                # /videos excludes Shorts; /streams is also included because
                # low-frequency music/creator channels may have archived streams.
                for tab in ['videos', 'streams']:
                    old_streak = 0
                    opts = {'extract_flat': True, 'lazy_playlist': True, 'skip_download': True, 'quiet': True,
                            'logger': QuietLogger(), 'socket_timeout': 25, 'retries': 2, 'extractor_retries': 2,
                            'playlistend': MAX_ITEMS + 1, 'extractor_args': {'youtubetab': {'approximate_date': ['true']}}}
                    with YoutubeDL(opts) as ydl:
                        try:
                            listing = ydl.extract_info(f'https://www.youtube.com/channel/{channel}/{tab}', download=False)
                        except Exception as error:
                            # An absent streams tab is normal; network/extractor
                            # failures must never be reported as completed history.
                            if tab == 'streams' and any(x in str(error).lower() for x in ['does not have a streams tab', 'this channel does not have', 'no uploads']):
                                continue
                            raise
                        for index, entry in enumerate(listing.get('entries') or []):
                            if index >= MAX_ITEMS:
                                full = False
                                break
                            if not entry or entry.get('is_live') or entry.get('live_status') in ['is_live', 'is_upcoming']:
                                continue
                            video_id = entry.get('id') or ''
                            title = str(entry.get('title') or '').strip()
                            if not VIDEO_ID.fullmatch(video_id) or video_id in seen or not title or title in ['[Private video]', '[Deleted video]'] or re.search(r'(^|\s)#shorts?(\s|$)', title, re.I):
                                continue
                            seen.add(video_id)
                            timestamp = entry.get('release_timestamp') or entry.get('timestamp')
                            precision = 'exact' if entry.get('release_timestamp') else 'estimated'
                            if not timestamp:
                                timestamp, precision = 0, 'unknown'
                            if policy == 'two-years' and timestamp and timestamp < cutoff:
                                old_streak += 1
                                if old_streak >= 10: break
                                continue
                            old_streak = 0
                            batch.append({'externalId': video_id, 'title': title[:500], 'summary': str(entry.get('description') or '')[:4000], 'publishedAt': max(0, int(timestamp)), 'publishedPrecision': precision})
                            if len(batch) >= 25: flush()
                flush()
                status = 'complete' if full else 'partial'
                state(source, policy, reason, status, '' if full else '达到单频道安全上限；历史未全部补齐')
                completed += int(full)
                partial += int(not full)
                stats['status'] = status
            except Exception as error:
                # Keep successful batches. Replaying them does not create copies
                # or overwrite exact metadata, read flags or stars.
                message = str(error) if isinstance(error, RuntimeError) else 'YouTube 历史目录暂不可访问；保留已导入内容，可重试'
                status = 'partial' if stats['added'] or stats['unchanged'] else 'failed'
                state(source, policy, reason, status, message)
                failed += 1
                stats.update(status=status, error=message)
            report['sources'].append(stats)
            print(f"source={source['id']} policy={policy} status={stats['status']} added={stats['added']} changed={stats['updated']} skipped={stats['unchanged']}", flush=True)
    finally:
        report['after'] = api('/sync/report')
        # Ephemeral runner file only; never upload a private subscription list as
        # a publicly downloadable Actions artifact.
        Path(os.environ.get('RSS_HISTORY_REPORT', 'rss-history-report.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'completed': completed, 'failed': failed, 'partial': partial, 'processed': total, 'beforeBytes': before['backend']['usedBytes'], 'afterBytes': report['after']['backend']['usedBytes'], 'duplicates': report['after']['duplicates']}, ensure_ascii=False), flush=True)
    if failed or partial:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
