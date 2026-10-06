import contextlib
import copy
import io
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import Mock, patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import jev_review as jev
import manage_issue_action as manage

REQUEST = {'protocol_version': '1', 'request_id': 'test', 'repository': 'owner/repo',
           'issue': {'number': 42, 'title': 'title', 'body': 'body', 'labels': ['state:coding'],
                     'state': 'state:coding', 'updated_at': '2026-10-05T00:00:00Z',
                     'comments': [{'id': 1, 'author': 'reviewer', 'body': '已确认根因，需要考虑并发时序。',
                                   'created_at': '2026-10-05T00:00:00Z', 'updated_at': '2026-10-05T00:00:00Z'}]},
           'reviewer': {'name': 'TypeSafe', 'model': 'jev-latest'}, 'agents': []}
RESPONSE = {'model': 'jev-1.13.0', 'answers': {'assignment': {'type': 'choice', 'choice': 'current_model',
            'confidence': .9, 'probabilities': {'stronger_model': .1, 'current_model': .9}}}, 'usage': {}}


class ReviewTests(unittest.TestCase):
    def invoke(self, error=None, response=RESPONSE, key='test-key'):
        opener = Mock()
        if error:
            opener.open.side_effect = error
        else:
            opener.open.return_value.__enter__ = Mock(return_value=Mock(read=Mock(return_value=json.dumps(response).encode())))
            opener.open.return_value.__exit__ = Mock(return_value=False)
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'TYPESAFE_API_KEY': key}), patch('sys.stdin', io.StringIO(json.dumps(REQUEST))), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), patch.object(jev.urllib.request, 'build_opener', return_value=opener) as build:
            code = jev.main()
        return code, out.getvalue(), err.getvalue(), opener, build

    def test_shape_auth_mapping(self):
        code, output, _, opener, _ = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output)['decision'], 'agent')
        call = opener.open.call_args
        req = call.args[0]
        self.assertEqual(req.full_url, jev.ENDPOINT)
        self.assertEqual(req.get_header('Authorization'), 'Bearer test-key')
        self.assertEqual(call.kwargs['timeout'], 60)
        body = json.loads(req.data)
        self.assertEqual(set(body), {'model', 'state', 'questions'})
        self.assertEqual(body['model'], 'jev-latest')
        self.assertEqual(body['state']['issue'], REQUEST['issue'])
        self.assertEqual(body['questions']['assignment']['type'], 'choice')
        self.assertEqual(body['state']['issue']['comments'], REQUEST['issue']['comments'])
        self.assertEqual(set(body['questions']['assignment']['criteria']), {'current_model', 'stronger_model'})
        for choice, decision in [('current_model', 'agent'), ('stronger_model', 'human')]:
            response = copy.deepcopy(RESPONSE)
            response['answers']['assignment']['choice'] = choice
            translated = jev.translate(REQUEST, response)
            self.assertEqual(translated['decision'], decision)
            self.assertIn('适配器生成', translated['reason'])
            self.assertEqual(len(translated), 6)

    def test_missing_key_never_network(self):
        code, out, err, opener, build = self.invoke(key='')
        self.assertEqual(code, 3)
        self.assertEqual(out, '')
        self.assertIn('TYPESAFE_API_KEY', err)
        build.assert_not_called()
        opener.open.assert_not_called()

    def test_errors_are_safe(self):
        for error, expected in [(urllib.error.HTTPError(jev.ENDPOINT, 401, 'secret body', {}, None), 4),
                                (urllib.error.HTTPError(jev.ENDPOINT, 429, 'secret body', {}, None), 5),
                                (urllib.error.URLError('secret body'), 7),
                                (socket.timeout('secret body'), 8)]:
            code, out, err, _, _ = self.invoke(error=error)
            self.assertEqual(code, expected)
            self.assertEqual(out, '')
            self.assertNotIn('secret body', err)
            self.assertNotIn('test-key', err)

    def test_invalid_response(self):
        for value in ('bogus', None, True):
            response = copy.deepcopy(RESPONSE)
            response['answers']['assignment']['choice'] = value
            self.assertEqual(self.invoke(response=response)[0], 9)
        for value in (float('nan'), float('inf'), -1, 2, True):
            response = copy.deepcopy(RESPONSE)
            response['answers']['assignment']['probabilities']['current_model'] = value
            self.assertEqual(self.invoke(response=response)[0], 9)
        for raw in ('bad json', '{"a": 1, "a": 2}', '{"a": NaN}'):
            with self.assertRaises(ValueError):
                jev.parse_json(raw)

    def test_request_invalid(self):
        request = copy.deepcopy(REQUEST)
        request['issue']['number'] = True
        with self.assertRaises(ValueError):
            jev.validate_request(request)

    def test_policy_and_real_missing_key_diagnostic(self):
        policy = manage.load_policy()
        self.assertEqual(policy['reviewer']['model'], 'jev-latest')
        # Use the current interpreter because macOS need not provide a `python` alias.
        import subprocess
        original_run = subprocess.run
        def run(command, **kwargs):
            if command == ['python', '.github/scripts/jev_review.py']:
                command = [sys.executable, command[1]]
            return original_run(command, **kwargs)
        issue = {'state': 'open', 'title': 'title', 'body': 'body', 'labels': [{'name': 'state:coding'}], 'updated_at': 'now'}
        error = io.StringIO()
        with patch.dict(os.environ, {'GH_REPO': 'owner/repo', 'TYPESAFE_API_KEY': ''}), patch.object(manage, 'run_gh', side_effect=[issue, [[]]]) as gh, patch('sys.argv', ['manage_issue_action.py', '--issue-number', '42']), patch.object(manage.subprocess, 'run', side_effect=run), contextlib.redirect_stderr(error):
            self.assertEqual(manage.main(), 1)
        self.assertIn('TYPESAFE_API_KEY is missing', error.getvalue())
        self.assertEqual(gh.call_count, 2)

    def test_stage_prompts_and_invalid_comments(self):
        prompts = jev.load_prompts()
        for stage in jev.STAGES:
            request = copy.deepcopy(REQUEST)
            request['issue']['state'] = stage
            request['issue']['labels'] = [stage]
            instructions = jev.payload(request)['questions']['assignment']['instructions']
            self.assertIn(prompts['stages'][stage], instructions)
            self.assertIn('更强', instructions)
        request = copy.deepcopy(REQUEST)
        request['issue']['comments'][0]['body'] = None
        with self.assertRaises(ValueError):
            jev.validate_request(request)


if __name__ == '__main__':
    unittest.main()
