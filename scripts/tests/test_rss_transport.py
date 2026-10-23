import importlib.util
import io
import os
import sys
import types
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class TransportTests(unittest.TestCase):
    def test_daily_fallback_respects_source_retention_window_and_deduplicates_tabs(self):
        class Directory:
            def __init__(self, opts):
                assert opts['playlistend'] == 15
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def extract_info(self, url, download):
                assert download is False
                return {'entries':[{'id':'oldvideo123','title':'old','timestamp':1000000000},{'id':'newvideo123','title':'recent','timestamp':1999999999}]}
        with tempfile.TemporaryDirectory() as directory:
            failures=Path(directory)/'failures.json'
            failures.write_text('[1,2]',encoding='utf-8')
            with patch.dict(os.environ,{'RSS_SYNC_TOKEN':'test-only','RSS_SYNC_FAILURE_FILE':str(failures)}),patch.dict(sys.modules,{'yt_dlp':types.SimpleNamespace(YoutubeDL=Directory)}):
                spec=importlib.util.spec_from_file_location('daily_fallback',Path(__file__).resolve().parents[1]/'rss-feed-fallback.py')
                module=importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            batches=[]
            def api(path, body=None):
                if path == '/sync/history-sources':
                    return {'sources':[{'id':identity,'policy':policy,'channelId':'UC'+'x'*22} for identity,policy in [(1,'two-years'),(2,'full')]]}
                if path == '/sync/history-batch':
                    batches.append(body)
                    return {'added':0,'updated':0,'unchanged':len(body['videos'])}
                self.assertEqual(path,'/sync/error')
                return {'ok':True}
            with patch.dict(os.environ,{'RSS_SYNC_FAILURE_FILE':str(failures)}),patch.object(module.history,'api',side_effect=api),patch.object(module.time,'time',return_value=2000000000):
                module.main()
            self.assertEqual([len(batch['videos']) for batch in batches],[1,2])
            self.assertEqual(batches[0]['videos'][0]['publishedPrecision'],'estimated')

    def test_existing_plaintext_success_and_json_contracts(self):
        with patch.dict(os.environ, {'RSS_SYNC_TOKEN':'test-only'}), patch.dict(sys.modules, {'yt_dlp':types.SimpleNamespace(YoutubeDL=object)}):
            spec=importlib.util.spec_from_file_location('transport_history', Path(__file__).resolve().parents[1]/'rss-history.py')
            module=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        for path, content, expected in [('/sync/error',b'OK',{'ok':True}),('/sync/history-batch',b'{"added":0}',{'added':0})]:
            with patch.object(module.urllib.request,'urlopen',return_value=io.BytesIO(content)) as request:
                self.assertEqual(module.api(path,{'subscriptionId':1,'error':''}),expected)
                self.assertEqual(request.call_count,1)

if __name__ == '__main__':
    unittest.main()
