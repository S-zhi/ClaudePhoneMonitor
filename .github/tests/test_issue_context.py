import contextlib
import copy
import io
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import manage_issue_action as manage

ENDPOINT = 'repos/owner/repo/issues/42'
ISSUE = {'title': 'title', 'body': 'description', 'state': 'open',
         'labels': [{'name': 'state:coding'}], 'updated_at': '2026-10-05T00:00:00Z'}
POLICY = {'reviewer': {'name': 'TypeSafe', 'model': 'jev-latest'}, 'agents': []}


def comment(number):
    return {'id': number, 'user': {'login': 'author'}, 'body': f'comment {number}',
            'created_at': '2026-10-05T00:00:00Z', 'updated_at': '2026-10-05T00:00:00Z'}


class IssueContextTests(unittest.TestCase):
    def invoke(self, initial, current=None, failure_call=None):
        requests, calls = [], []
        comment_reads = 0

        def gh(args):
            nonlocal comment_reads
            calls.append(args)
            if '--paginate' in args:
                comment_reads += 1
                if failure_call == comment_reads:
                    raise subprocess.CalledProcessError(1, ['gh', 'api'])
                return copy.deepcopy(initial if comment_reads == 1 or current is None else current)
            return copy.deepcopy(ISSUE)

        def review(policy, request):
            requests.append(request)
            return 'agent'

        with patch.dict(os.environ, {'GH_REPO': 'owner/repo'}), patch.object(sys, 'argv', ['manage', '--issue-number', '42']), patch.object(manage, 'load_policy', return_value=POLICY), patch.object(manage, 'load_and_validate', return_value=[{'name': 'state:coding'}]), patch.object(manage, 'run_gh', side_effect=gh), patch.object(manage, 'review', side_effect=review), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = manage.main()
        writes = [args for args in calls if '--method' in args]
        return code, requests, writes, calls

    def test_empty_comments(self):
        code, requests, writes, calls = self.invoke([[]])
        self.assertEqual(code, 0)
        self.assertEqual(requests[0]['issue']['comments'], [])
        self.assertEqual(requests[0]['issue']['body'], 'description')
        self.assertEqual(len(writes), 1)
        self.assertEqual(calls[1], ['--paginate', '--slurp', ENDPOINT + '/comments?per_page=100'])

    def test_all_pages_over_one_hundred_and_deleted_author(self):
        pages = [[comment(n) for n in range(1, 101)], [comment(101), comment(102)]]
        pages[1][1]['user'] = None
        code, requests, writes, _ = self.invoke(pages)
        self.assertEqual(code, 0)
        self.assertEqual(len(requests[0]['issue']['comments']), 102)
        self.assertIsNone(requests[0]['issue']['comments'][-1]['author'])
        self.assertEqual(len(writes), 1)

    def test_changed_comments_skip_assignment(self):
        initial = [[comment(1)]]
        edited = copy.deepcopy(initial)
        edited[0][0]['body'] = 'edited'
        timestamp = copy.deepcopy(initial)
        timestamp[0][0]['updated_at'] = '2026-10-05T01:00:00Z'
        for current in (edited, timestamp, [[comment(1), comment(2)]], [[]]):
            with self.subTest(current=current):
                code, requests, writes, _ = self.invoke(initial, current)
                self.assertEqual(code, 0)
                self.assertEqual(len(requests), 1)
                self.assertEqual(writes, [])

    def test_pagination_failure_never_assigns(self):
        for failure_call in (1, 2):
            code, requests, writes, _ = self.invoke([[comment(1)]], failure_call=failure_call)
            self.assertEqual(code, 1)
            self.assertEqual(len(requests), failure_call - 1)
            self.assertEqual(writes, [])

    def test_malformed_comments_never_reviewed(self):
        invalid = [[], [{}], [[None]], [[comment(1), comment(1)]]]
        for field, value in [('id', True), ('body', None), ('created_at', ''), ('updated_at', None), ('user', {})]:
            item = comment(1)
            item[field] = value
            invalid.append([[item]])
        for pages in invalid:
            code, requests, writes, _ = self.invoke(pages)
            self.assertEqual(code, 1)
            self.assertEqual(requests, [])
            self.assertEqual(writes, [])

    def test_snapshot_order_is_deterministic(self):
        code, requests, writes, _ = self.invoke([[comment(2)], [comment(1)]], [[comment(1), comment(2)]])
        self.assertEqual(code, 0)
        self.assertEqual([item['id'] for item in requests[0]['issue']['comments']], [1, 2])
        self.assertEqual(len(writes), 1)


if __name__ == '__main__':
    unittest.main()
