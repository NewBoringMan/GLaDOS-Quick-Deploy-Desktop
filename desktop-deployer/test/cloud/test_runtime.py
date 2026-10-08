import base64
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'cloud'))
import runner
import cleanup
from common import GitHub, UTC, day, cron

A = '85EB2FD65EC54FBC'
B = 'B58C05D3D0799136'
NOW = dt.datetime(2026, 10, 8, 8, 0, tzinfo=UTC)


def receipt(**kwargs):
    return {'schemaVersion': 2, 'accountKey': A, 'phase': 'final', 'businessDate': '2026-10-08', 'observedAt': '2026-10-08T07:00:00Z',
            'runId': '10', 'runAttempt': '1', 'credentialRevision': 'rev', **kwargs}


class Scheduling(unittest.TestCase):
    def config(self):
        return {'accounts': [{'accountKey': A, 'times': ['12:30', '22:13'], 'enabled': True}, {'accountKey': B, 'times': ['18:37'], 'enabled': False}]}

    def test_schedule_selects_correct_account(self):
        self.assertEqual(runner.select_accounts(self.config(), 'schedule', 'checkin', '', '30 4 * * *'), [{'account': A}])

    def test_other_slot_cannot_run_account(self):
        self.assertEqual(runner.select_accounts(self.config(), 'schedule', 'checkin', '', '37 10 * * *'), [])

    def test_manual_all_respects_paused(self):
        self.assertEqual(runner.select_accounts(self.config(), 'workflow_dispatch', 'checkin', '', ''), [{'account': A}])

    def test_status_all_can_read_paused_without_signing(self):
        self.assertEqual(len(runner.select_accounts(self.config(), 'workflow_dispatch', 'status', '', '')), 2)

    def test_unknown_target_rejected(self):
        with self.assertRaises(ValueError):
            runner.select_accounts(self.config(), 'workflow_dispatch', 'checkin', 'FFFFFFFFFFFFFFFF', '')

    def test_day_boundary(self):
        self.assertEqual(day(dt.datetime(2026, 10, 8, 15, 59, tzinfo=UTC)), '2026-10-08')
        self.assertEqual(day(dt.datetime(2026, 10, 8, 16, 0, tzinfo=UTC)), '2026-10-09')

    def test_utc_conversion(self):
        self.assertEqual(cron('03:43'), '43 19 * * *')

    def test_no_history_fallback_can_sign(self):
        self.assertTrue(runner.decide([], A, 'rev', 'checkin', '2026-10-08')['checkin'])

    def test_success_today_prevents_repeat(self):
        prior = receipt(checkinConfirmed=True, checkinBusinessDate='2026-10-08')
        decision = runner.decide([prior], A, 'new-revision', 'checkin', '2026-10-08')
        self.assertFalse(decision['checkin'])
        self.assertFalse(decision['blocked'])

    def test_yesterday_success_is_not_today(self):
        prior = receipt(businessDate='2026-10-07', checkinConfirmed=True, checkinBusinessDate='2026-10-07')
        self.assertTrue(runner.decide([prior], A, 'rev', 'checkin', '2026-10-08')['checkin'])

    def test_transient_failure_can_use_next_slot(self):
        prior = receipt(outcome='failed', errorKind='rate_limited', checkinConfirmed=False)
        self.assertTrue(runner.decide([prior], A, 'rev', 'checkin', '2026-10-08')['checkin'])

    def test_auth_failure_blocks_retries_until_credentials_change(self):
        prior = receipt(authenticationRequired=True)
        self.assertTrue(runner.decide([prior], A, 'rev', 'checkin', '2026-10-08')['blocked'])
        self.assertFalse(runner.decide([prior], A, 'new', 'checkin', '2026-10-08')['blocked'])

    def test_missing_final_receipt_blocks_ambiguous_reexecution(self):
        prior = receipt(phase='intent', sideEffects=True)
        self.assertEqual(runner.decide([prior], A, 'rev', 'checkin', '2026-10-08')['reason'], 'previous_uncertain')

    def test_status_query_never_has_side_effects(self):
        self.assertFalse(runner.decide([], A, 'rev', 'status', '2026-10-08')['checkin'])

    def test_final_receipt_resolves_matching_intent(self):
        records = [receipt(phase='intent', sideEffects=True), receipt(checkinConfirmed=True, checkinBusinessDate='2026-10-08')]
        self.assertFalse(runner.decide(records, A, 'rev', 'checkin', '2026-10-08')['blocked'])

    def test_previous_day_orphan_intent_guards_exchange_without_blocking_checkin(self):
        prior = receipt(phase='intent', sideEffects=True, businessDate='2026-10-07', observedAt='2026-10-07T15:59:00Z')
        decision = runner.decide([prior], A, 'rev', 'checkin', '2026-10-08')
        self.assertTrue(decision['checkin'])
        self.assertFalse(decision['blocked'])
        self.assertTrue(decision['exchange']['exchangeUncertain'])

    def test_new_credentials_do_not_resolve_an_orphan_exchange(self):
        prior = receipt(phase='intent', sideEffects=True)
        decision = runner.decide([prior], A, 'new-revision', 'checkin', '2026-10-08')
        self.assertTrue(decision['checkin'])
        self.assertFalse(decision['blocked'])
        self.assertTrue(decision['exchange']['exchangeUncertain'])

    def test_previous_day_final_resolves_its_matching_intent(self):
        records = [receipt(phase='intent', sideEffects=True, businessDate='2026-10-07'),
                   receipt(businessDate='2026-10-07', checkinConfirmed=True, checkinBusinessDate='2026-10-07')]
        decision = runner.decide(records, A, 'rev', 'checkin', '2026-10-08')
        self.assertTrue(decision['checkin'])
        self.assertFalse(decision['blocked'])
        self.assertIsNone(decision['exchange'])

    def test_uncertain_post_never_blindly_retried(self):
        self.assertTrue(runner.decide([receipt(checkinUncertain=True)], A, 'rev', 'checkin', '2026-10-08')['blocked'])

    def test_credential_values_not_in_fingerprint(self):
        cookie, ua, revision = runner.credential(json.dumps({'cookie': 'gld:sess=secret; gld:sess.sig=signature', 'userAgent': 'browser', 'origin': 'https://glados.cloud'}))
        self.assertEqual(len(revision), 64)
        self.assertNotIn('secret', revision)

    def test_invalid_credential_header_rejected(self):
        with self.assertRaises(ValueError):
            runner.credential(json.dumps({'cookie': 'gld:sess=secret\r\nBad=1; gld:sess.sig=signature', 'userAgent': 'browser'}))


class Client:
    def __init__(self, points=400, response=None):
        self.points = points
        self.response = response if response is not None else {'code': 0}
        self.checks = 0
        self.exchanges = 0
        self.reads = 0
    def req(self, method, url):
        assert method == 'GET'
        self.reads += 1
        if url.endswith('/status'):
            return {'data': {'email': 'test@example.com', 'leftDays': 90}}
        return {'points': self.points, 'plans': {'plan500': {'points': 500, 'days': 100}}}
    def checkin(self):
        self.checks += 1
        self.points += 11
        return self.response
    def exchange(self, plan):
        self.exchanges += 1
        self.points -= 500
        return {'code': 0}


class Runtime(unittest.TestCase):
    def invoke(self, client, previous=None, operation='checkin', plan='plan500'):
        rec = receipt()
        previous = previous or {'checkin': operation == 'checkin', 'blocked': False, 'confirmed': None, 'exchange': None, 'uncertain': False}
        upstream = type('Upstream', (), {'is_normal_checkin_result': staticmethod(lambda x: isinstance(x, dict) and x.get('code') == 0)})
        with mock.patch.object(runner, 'day', return_value='2026-10-08'), mock.patch.object(runner, 'write_json'):
            detail = runner.run_account(client, upstream, previous, operation, {'exchangePlan': plan}, rec, {'status': 200})
        return rec, detail

    def test_normal_sign_and_points(self):
        client = Client()
        rec, detail = self.invoke(client)
        self.assertTrue(rec['checkinConfirmed'])
        self.assertEqual(rec['pointsAdded'], 11)
        self.assertEqual(detail['points'], 411)
        self.assertEqual(client.checks, 1)
        self.assertEqual(client.exchanges, 0)

    def test_status_does_not_sign_or_exchange(self):
        client = Client(points=999)
        rec, detail = self.invoke(client, operation='status')
        self.assertEqual(client.checks, 0)
        self.assertEqual(client.exchanges, 0)
        self.assertEqual(rec['outcome'], 'status_only')
        self.assertEqual(detail['points'], 999)

    def test_accepted_sign_can_exchange_once(self):
        client = Client(points=500)
        rec, detail = self.invoke(client)
        self.assertEqual(client.exchanges, 1)
        self.assertEqual(rec['exchange'], 'completed')
        self.assertEqual(detail['points'], 11)
        self.assertFalse(rec['exchangeUncertain'])

    def test_successful_account_not_posted_again(self):
        client = Client()
        saved = receipt(checkinConfirmed=True, checkinBusinessDate='2026-10-08', checkinConfirmedAt='2026-10-08T05:00Z', pointsAdded=11)
        previous = {'checkin': False, 'blocked': False, 'confirmed': saved, 'exchange': None, 'uncertain': False}
        rec, detail = self.invoke(client, previous)
        self.assertEqual(client.checks, 0)
        self.assertTrue(rec['checkinConfirmed'])
        self.assertEqual(rec['pointsAdded'], 11)

    def test_exchange_success_not_repeated(self):
        client = Client(points=2000)
        saved = receipt(checkinConfirmed=True, checkinBusinessDate='2026-10-08')
        previous = {'checkin': False, 'blocked': False, 'confirmed': saved, 'exchange': {'exchangeConfirmedAt': '2026-10-08T05:00Z'}, 'uncertain': False}
        rec, _ = self.invoke(client, previous)
        self.assertEqual(client.exchanges, 0)
        self.assertEqual(rec['exchange'], 'already_completed')

    def test_uncertain_exchange_does_not_deduct_again(self):
        client = Client(points=2000)
        saved = receipt(checkinConfirmed=True, checkinBusinessDate='2026-10-08')
        previous = {'checkin': False, 'blocked': False, 'confirmed': saved, 'exchange': {'exchangeUncertain': True}, 'uncertain': False}
        rec, _ = self.invoke(client, previous)
        self.assertEqual(client.exchanges, 0)
        self.assertEqual(rec['exchange'], 'uncertain')

    def test_previous_day_orphan_still_allows_today_checkin_after_login_changes(self):
        client = Client(points=2000)
        prior = receipt(phase='intent', sideEffects=True, businessDate='2026-10-07', observedAt='2026-10-07T15:59:00Z')
        previous = runner.decide([prior], A, 'new-revision', 'checkin', '2026-10-08')
        rec, _ = self.invoke(client, previous)
        self.assertEqual(client.checks, 1)
        self.assertEqual(client.exchanges, 0)
        self.assertTrue(rec['checkinConfirmed'])
        self.assertTrue(rec['exchangeUncertain'])
        self.assertEqual(rec['exchange'], 'uncertain')

    def test_unknown_exchange_response_keeps_uncertainty(self):
        for response in ({}, [], {'message': 'unknown'}, {'code': None}, {'code': '0'},
                         {'code': False}, {'code': True}, {'code': 1}):
            with self.subTest(response=response):
                client = Client(points=1100)
                client.exchange = lambda _p: response
                rec, _ = self.invoke(client)
                self.assertTrue(rec['checkinConfirmed'])
                self.assertTrue(rec['exchangeUncertain'])
                self.assertEqual(rec['exchange'], 'uncertain')

    def test_unknown_exchange_response_cannot_repeat_on_next_slot(self):
        client = Client(points=1100)
        client.exchange = lambda _p: {}
        rec, _ = self.invoke(client)
        next_client = Client(points=600)
        previous = runner.decide([rec], A, 'new-revision', 'checkin', '2026-10-08')
        next_receipt, _ = self.invoke(next_client, previous)
        self.assertEqual(next_client.checks, 0)
        self.assertEqual(next_client.exchanges, 0)
        self.assertTrue(next_receipt['checkinConfirmed'])
        self.assertEqual(next_receipt['exchange'], 'uncertain')

    def test_exchange_failure_does_not_erase_sign_success(self):
        client = Client(points=600)
        client.exchange = lambda _p: {'code': -1}
        rec, _ = self.invoke(client)
        self.assertTrue(rec['checkinConfirmed'])
        self.assertEqual(rec['exchange'], 'failed')

    def test_auth_failure_does_not_exchange(self):
        client = Client(points=1000, response={'code': -2})
        rec, _ = self.invoke(client)
        self.assertTrue(rec['authenticationRequired'])
        self.assertEqual(client.exchanges, 0)

    def test_auth_guard_makes_no_request(self):
        client = Client()
        previous = {'checkin': False, 'blocked': True, 'confirmed': None, 'exchange': None, 'uncertain': False, 'reason': 'authentication'}
        rec, _ = self.invoke(client, previous)
        self.assertEqual(client.reads + client.checks + client.exchanges, 0)
        self.assertEqual(rec['outcome'], 'authentication_required')

    def test_explicit_off_respected(self):
        client = Client(points=999)
        rec, _ = self.invoke(client, plan='off')
        self.assertEqual(rec['exchange'], 'disabled')
        self.assertEqual(client.exchanges, 0)


class CleanupGitHub(GitHub):
    """Use real pagination against an isolated, changing in-memory API."""
    def __init__(self, runs, changed=None, failed_deletes=(), unverified_deletes=()):
        self.runs = {run['id']: dict(run) for run in runs}
        self.changed = dict(changed or {})
        self.failed_deletes = set(failed_deletes)
        self.unverified_deletes = set(unverified_deletes)
        self.events = []

    def request(self, path, method='GET', missing_ok=False):
        url = urlsplit(path)
        query = parse_qs(url.query)
        if url.path == '/contents/.glados-quick-deploy.json':
            marker = {'appId': 'glados-quick-deploy', 'schemaVersion': 1}
            return {'content': base64.b64encode(json.dumps(marker).encode()).decode()}
        if url.path == '/actions/runs':
            page = int(query.get('page', ['1'])[0])
            size = int(query.get('per_page', ['100'])[0])
            self.events.append(('list_runs', page))
            runs = list(self.runs.values())
            return {'workflow_runs': [dict(run) for run in runs[(page-1)*size:page*size]]}
        if url.path == '/actions/caches':
            return {'actions_caches': []}
        pieces = url.path.split('/')
        if pieces[1:3] == ['actions', 'runs'] and len(pieces) in (4, 5):
            run_id = int(pieces[3])
            if len(pieces) == 5 and pieces[4] == 'artifacts':
                return {'artifacts': [{'id': run_id * 10, 'size_in_bytes': 7}]}
            if method == 'DELETE':
                self.events.append(('delete_run', run_id))
                if run_id in self.failed_deletes:
                    raise RuntimeError('fixture deletion failure')
                if run_id not in self.unverified_deletes:
                    self.runs.pop(run_id, None)
                return None
            self.events.append(('get_run', run_id))
            if run_id in self.changed:
                self.runs[run_id].update(self.changed.pop(run_id))
            run = self.runs.get(run_id)
            if run is None and not missing_ok:
                raise RuntimeError('fixture run not found')
            return dict(run) if run else None
        raise AssertionError('unexpected fixture request: ' + method + ' ' + path)


class Cleanup(unittest.TestCase):
    def old(self, **patch):
        return {'id': 20, 'status': 'completed', 'path': '.github/workflows/glados-quick-deploy.yml', 'created_at': '2026-10-01T01:00Z', 'updated_at': '2026-10-01T01:01Z', 'run_started_at': '2026-10-01T01:00Z', 'run_attempt': 1, **patch}

    def test_only_older_than_72h(self):
        cutoff = NOW - dt.timedelta(hours=72)
        self.assertTrue(cleanup.expired_run(self.old(), cutoff, 99))
        self.assertFalse(cleanup.expired_run(self.old(updated_at=cutoff.isoformat()), cutoff, 99))

    def test_running_and_current_never_removed(self):
        self.assertFalse(cleanup.expired_run(self.old(status='in_progress'), NOW, 99))
        self.assertFalse(cleanup.expired_run(self.old(), NOW, 20))

    def test_unrelated_workflow_preserved(self):
        self.assertFalse(cleanup.expired_run(self.old(path='.github/workflows/build.yml'), NOW, 99))

    def test_recent_rerun_retained(self):
        self.assertFalse(cleanup.expired_run(self.old(updated_at=NOW.isoformat(), run_attempt=2), NOW-dt.timedelta(hours=72), 99))

    def test_missing_timestamps_fail_closed(self):
        self.assertFalse(cleanup.expired_run(self.old(run_started_at=None), NOW, 99))

    def test_cache_filters_recent_and_unrelated(self):
        cache = {'key': 'gqd-v2-pip-x', 'created_at': '2026-10-01T00:00Z', 'last_accessed_at': '2026-10-01T00:00Z'}
        self.assertTrue(cleanup.old_cache(cache, NOW-dt.timedelta(hours=72)))
        self.assertFalse(cleanup.old_cache({**cache, 'key': 'unrelated'}, NOW))
        self.assertFalse(cleanup.old_cache({**cache, 'last_accessed_at': NOW.isoformat()}, NOW-dt.timedelta(hours=72)))

    def test_shared_setup_python_cache_is_not_owned_by_quick_deploy(self):
        cache = {'key': 'setup-python-Linux-x64-3.11-pip-other-workflow',
                 'created_at': '2026-10-01T00:00Z', 'last_accessed_at': '2026-10-01T00:00Z'}
        self.assertFalse(cleanup.old_cache(cache, NOW-dt.timedelta(hours=72)))

    def test_cleanup_snapshots_all_pages_before_deleting(self):
        unrelated = self.old(id=206, path='.github/workflows/build.yml')
        recent = self.old(id=207, updated_at=NOW.isoformat())
        api = CleanupGitHub([self.old(id=i) for i in range(1, 206)] + [unrelated, recent])
        result = cleanup.cleanup(api, now=NOW, current_id=9999)
        listings = [(index, event[1]) for index, event in enumerate(api.events) if event[0] == 'list_runs']
        deletions = [(index, event[1]) for index, event in enumerate(api.events) if event[0] == 'delete_run']
        self.assertEqual([page for _, page in listings], [1, 2, 3])
        self.assertGreater(min(index for index, _ in deletions), max(index for index, _ in listings))
        self.assertEqual([run_id for _, run_id in deletions], list(range(1, 206)))
        self.assertEqual(result['deletedRuns'], 205)
        self.assertEqual(result['deletedArtifacts'], 205)
        self.assertEqual(result['artifactBytes'], 205 * 7)
        self.assertEqual(result['errors'], [])
        self.assertEqual(api.runs, {206: unrelated, 207: recent})

    def test_cleanup_rechecks_changes_and_counts_only_verified_deletions(self):
        unrelated = self.old(id=5, path='.github/workflows/build.yml')
        api = CleanupGitHub([self.old(id=i) for i in (1, 2, 3, 4, 6)] + [unrelated],
                            changed={1: {'status': 'in_progress'}, 2: {'updated_at': NOW.isoformat()}},
                            failed_deletes={3}, unverified_deletes={6})
        result = cleanup.cleanup(api, now=NOW, current_id=9999)
        self.assertEqual([event[1] for event in api.events if event[0] == 'delete_run'], [3, 4, 6])
        self.assertEqual(result['skippedChanged'], 2)
        self.assertEqual(result['deletedRuns'], 1)
        self.assertEqual(result['deletedArtifacts'], 1)
        self.assertEqual(result['artifactBytes'], 7)
        self.assertEqual(result['errors'], [{'kind': 'run', 'id': 3}, {'kind': 'run', 'id': 6}])
        self.assertEqual(set(api.runs), {1, 2, 3, 5, 6})
        self.assertEqual(api.runs[5], unrelated)


if __name__ == '__main__':
    unittest.main()
