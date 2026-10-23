import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rss_history_policy import classify, recover_channel

class PolicyTests(unittest.TestCase):
    def test_prefixless_atom_channel_ids_and_canonical_links(self):
        bare='Vh47EKH9VLresRqiYi9txw'
        for source in [{'channelId':bare},{'channelId':'UC'+bare},{'siteUrl':'https://www.youtube.com/channel/UC'+bare}]:
            self.assertEqual(recover_channel(source), 'UC'+bare)
        self.assertEqual(recover_channel({'channelId':'not-a-channel'}),'')
    def test_inactive_institution_is_not_a_personal_creator(self):
        self.assertEqual(classify({'title':'SpaceX','recent90':0,'newest':0}, 20000000)[0], 'two-years')
    def test_low_frequency_and_dormant_creators_get_full_history(self):
        for source in [{'title':'Mili','recent90':4,'newest':19900000}, {'title':'My channel','recent90':0,'newest':0}]:
            self.assertEqual(classify(source, 20000000)[0], 'full')
    def test_high_frequency_and_missing_evidence_are_bounded(self):
        self.assertEqual(classify({'title':'My channel','recent90':15,'newest':19900000}, 20000000)[0], 'two-years')
        self.assertEqual(classify({'title':'Unknown','recent90':0},20000000)[0], 'two-years')

if __name__ == '__main__': unittest.main()
