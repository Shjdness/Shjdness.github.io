import importlib.util
import io
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

class TransportTests(unittest.TestCase):
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
