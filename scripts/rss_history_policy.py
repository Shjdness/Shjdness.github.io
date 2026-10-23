"""Explainable prioritization; inactivity alone does not identify a creator."""
import re
import time
from urllib.parse import urlparse, parse_qs

INSTITUTIONS = re.compile(r'\b(?:TED(?:-Ed)?|PBS|NOVA|NASA|SpaceX|BBC|DW Documental|National Geographic|Paramount|Museum of Modern Art)\b', re.I)

def recover_channel(source):
    candidates = [source.get('channelId') or '', source.get('externalId') or '']
    for key in ['siteUrl', 'feedUrl']:
        url = urlparse(source.get(key) or '')
        if url.hostname in ['youtube.com', 'www.youtube.com']:
            candidates.extend(parse_qs(url.query).get('channel_id', []))
            match = re.match(r'^/channel/(UC[A-Za-z0-9_-]+)', url.path)
            if match: candidates.append(match.group(1))
    for candidate in candidates:
        if re.fullmatch(r'UC[A-Za-z0-9_-]{22}', candidate): return candidate
        if re.fullmatch(r'[A-Za-z0-9_-]{22}', candidate): return 'UC' + candidate
    return ''

def classify(source, now=None):
    now = time.time() if now is None else now
    title = f"{source.get('title', '')} {source.get('alias', '')}"
    recent = int(source.get('recent90') or 0)
    newest = source.get('newest')
    dormant = newest is not None and now - float(newest) >= 90 * 86400
    if INSTITUTIONS.search(title):
        return 'two-years', f'机构/媒体频道；近90天已收录{recent}条；先补近两年，已有内容保留'
    if newest is None:
        return 'two-years', '近期样本不足，暂不推断为低频个人频道；先补近两年'
    if dormant:
        return 'full', f'非机构频道，已收录最新发布距今超过90天；优先补齐可访问历史'
    if recent <= 12:
        return 'full', f'非机构频道，近90天已收录{recent}条（低频候选）；优先补齐可访问历史'
    return 'two-years', f'非机构高频候选，近90天至少{recent}条；先补近两年，再按需扩展'
