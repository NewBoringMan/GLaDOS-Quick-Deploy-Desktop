import base64
import datetime as dt
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'cloud'))
import runner
import cleanup
from common import UTC, day, cron

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


if __name__ == '__main__':
    unittest.main()
