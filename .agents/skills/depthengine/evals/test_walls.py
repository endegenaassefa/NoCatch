"""Acceptance tests for the wall ladder doctor — honest negatives included."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

WALLS = Path(os.environ.get('DEPTH_WALLS_UNDER_TEST',
                            str(Path(__file__).resolve().parent.parent / 'scripts/walls.py'))).resolve()


class WallsDoctorAcceptance(unittest.TestCase):
    def run_doctor(self, env=None):
        base = dict(os.environ)
        base['PATH'] = '/nonexistent-doctor-path'
        base['DEPTH_TOOLS_PREFIX'] = str(tempfile.mkdtemp(prefix='depth-tools-'))
        if env:
            base.update(env)
        return subprocess.run([sys.executable, str(WALLS), 'doctor'],
                              capture_output=True, env=base, timeout=60)

    def test_doctor_reports_all_three_tiers_and_honest_shape(self):
        result = self.run_doctor()
        payload = json.loads(result.stdout.decode())
        self.assertIn('tiers', payload)
        self.assertEqual(set(payload['tiers']), {'headless', 'real_browser', 'api_computer'})
        for tier in payload['tiers'].values():
            self.assertIn(tier['status'], ('ready', 'installable', 'unavailable', 'configured'))
        self.assertIn('recommended_tier', payload)
        self.assertIn('ladder', payload)

    def test_nothing_installed_is_honest_negative(self):
        result = self.run_doctor(env={'ANTHROPIC_API_KEY': '', 'OPENAI_API_KEY': '',
                                      'DEPTH_AGENT_BROWSER': '', 'DEPTH_OPENCLI_PACKAGE': ''})
        payload = json.loads(result.stdout.decode())
        self.assertEqual(payload['status'], 'none_ready')
        self.assertIsNone(payload['recommended_tier'])
        self.assertEqual(result.returncode, 1)

    def test_key_alone_never_claims_readiness(self):
        result = self.run_doctor(env={'ANTHROPIC_API_KEY': 'sk-fake', 'OPENAI_API_KEY': ''})
        payload = json.loads(result.stdout.decode())
        self.assertEqual(payload['tiers']['api_computer']['status'], 'configured')
        self.assertEqual(payload['tiers']['api_computer']['configured'], ['ANTHROPIC_API_KEY'])
        self.assertIn('no tier-3 adapter', payload['tiers']['api_computer']['scope'])
        self.assertEqual(payload['status'], 'none_ready')
        self.assertIsNone(payload['recommended_tier'])

    def test_ladder_command(self):
        result = subprocess.run([sys.executable, str(WALLS), 'ladder'],
                                capture_output=True, env=dict(os.environ), timeout=60)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(json.loads(result.stdout.decode())), 3)


if __name__ == '__main__':
    unittest.main()
