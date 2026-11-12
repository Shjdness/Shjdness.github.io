"""Read-only daily planning: do not install/backfill when all sources are complete."""
import json
import os
import urllib.request
endpoint=(os.environ.get('RSS_SYNC_ENDPOINT') or 'https://rin-server.1322589722.workers.dev').rstrip('/')
request=urllib.request.Request(endpoint+'/rss/sync/history-sources?scope=probe',headers={'Authorization':'Bearer '+os.environ['RSS_SYNC_TOKEN'],'User-Agent':'ShjdnessRSS/1.0'})
with urllib.request.urlopen(request,timeout=30) as response:
    sources=json.load(response)['sources']
pending=any(source.get('status')!='complete' for source in sources)
with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as output:
    output.write('pending='+str(pending).lower()+'\n')
print('Pending history exists' if pending else 'All histories complete; no backfill or feed refetch needed')
