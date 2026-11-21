"""Real Hermes contracts, isolated from any paired home. Set CLAWY_HERMES_SOURCE to run."""
import asyncio
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from unittest.mock import patch
import tempfile
import unittest


class CronContractTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('CLAWY_HERMES_SOURCE'), 'Set CLAWY_HERMES_SOURCE to the Hermes source checkout')
    def test_scheduled_results_and_routing(self):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'probe'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class Store:
    """Turn leases and compression, which Hermes 0.23 moved off `SessionDB` to its storage interface."""

    def __init__(self, home):
        try:
            from persistence_assembly import open_persistence, profile_scope
        except ImportError:
            from hermes_state_registry import acquire
            self.db, self.store = acquire(home / 'state.db'), None
        else:
            self.db, self.store = None, open_persistence(profile_scope(home=home))

    def hold_turn(self, session, holder):
        if self.store is None:
            return self.db.try_acquire_session_turn_lease(session, holder)
        return self.store.coordination.try_acquire_turn_lease(session_id=session, holder=holder)

    def release_turn(self, session, holder):
        if self.store is None:
            return self.db.release_session_turn_lease(session, holder)
        self.store.coordination.release_turn_lease(session_id=session, holder=holder)

    def compress(self, parent, child, handoff):
        holder = 'compression-test'
        if self.store is None:
            assert self.db.try_acquire_compression_lock(parent, holder)
            self.db.publish_compression_child(parent_session_id=parent, child_session_id=child, source='clawy',
                                              messages=[{'role': 'user', 'content': handoff}], compression_lock_holder=holder)
            return
        from persistence.conversation.lineage import CompressionChild
        from persistence.conversation.messages import NewMessage
        assert self.store.coordination.try_acquire_compression_lock(session_id=parent, holder=holder)
        self.store.lineage.publish_compression_child(parent, CompressionChild(session_id=child, source='clawy'),
                                                     [NewMessage(role='user', content=handoff)], compression_lock_holder=holder)

    def close(self):
        if self.store is None:
            from hermes_state_registry import release_or_close
            release_or_close(self.db)
        else:
            self.store.close()


def probe():
    sys.path.insert(0, os.environ['CLAWY_HERMES_SOURCE'])
    with tempfile.TemporaryDirectory(prefix='clawy-cron-') as folder:
        home = Path(folder)
        os.environ['HERMES_HOME'] = folder
        os.environ.pop('HERMES_PROFILE', None)
        from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager, _dispatch_pre_tool_call_hooks
        from gateway.session_context import set_session_vars
        from hermes_state_registry import acquire, release_or_close
        from cron.scheduler_delivery import _deliver_result, _is_known_delivery_platform
        from cron.delivery_queue import enqueue, drain, get_status
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('clawy_cron_contract', root / '__init__.py', submodule_search_locations=[str(root)])
        plugin = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = plugin
        spec.loader.exec_module(plugin)
        # Drain explicitly for deterministic fault injection; the live app proof exercises the worker.
        work = plugin.CronDelivery._work
        plugin.CronDelivery._work = lambda self: self.first_pass.set()
        manager = get_plugin_manager()
        manager.discover_and_load()
        ctx = PluginContext(PluginManifest(name='clawy-contract', key='clawy-contract', source='user'), manager)
        plugin.register(ctx)
        assert _is_known_delivery_platform('clawy'), 'cron preflight must recognize the platform'
        observer = plugin._notifications
        alerts = []
        observer.delivery.submit = alerts.append
        db = acquire(home / 'state.db')
        store = Store(home)
        # The plugin's adapter for this Hermes's session store, where faults are injected.
        with plugin.cron._sessions(home) as state:
            notes, contention = type(state), state.contention[0]
        sid = 'clawy-original'
        db.create_session(sid, source='clawy')
        db.append_message(sid, 'user', content='Schedule this')
        db.create_session('telegram-session', source='telegram')
        # (deliver, routed from a Clawy chat, routed from any other surface). Hermes's own
        # `local:<chat>` lane refuses a dashboard chat at every fire (no gateway receipt).
        cases = [(None, 'clawy:' + sid, None), ('origin', 'clawy:' + sid, 'origin'), ('local', 'local', 'local'),
                 ('telegram:123', 'telegram:123', 'telegram:123'),
                 ('origin,telegram:123', f'clawy:{sid},telegram:123', 'origin,telegram:123'),
                 ('local:' + sid, 'clawy:' + sid, 'clawy:' + sid),
                 (f' local:{sid} ,telegram:123', f'clawy:{sid},telegram:123', f'clawy:{sid},telegram:123'),
                 (f'local:{sid},origin', 'clawy:' + sid, f'clawy:{sid},origin'),
                 ('local:telegram-session', 'local:telegram-session', 'local:telegram-session'),
                 ('local:missing-session', 'local:missing-session', 'local:missing-session')]
        for source in ('telegram', 'dashboard', 'cli', 'clawy'):
            set_session_vars(source=source, session_id=sid, session_key=sid, cron_session='')
            for delivery, from_clawy, from_other in cases:
                args = dict(action='create', prompt='Safe result', schedule='every 1h')
                if delivery is not None:
                    args['deliver'] = delivery
                block, changed = _dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)
                changed = changed or args
                expected = from_clawy if source == 'clawy' else from_other
                assert changed.get('deliver') == expected, (source, delivery, changed)
                assert changed['prompt'] == args['prompt'] and block is None
        # A Clawy chat's turn the gateway owner runs binds it as a local chat with no source.
        for chat, expected in ((sid, 'clawy:' + sid), ('telegram-session', None), ('missing-session', None)):
            set_session_vars(platform='local', chat_id=chat, session_id=chat, session_key='agent:main:local:' + chat,
                             source='', cron_session='')
            args = dict(action='create', prompt='Safe result', schedule='every 1h', failure_deliver='origin')
            changed = _dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=chat)[1] or args
            assert changed.get('deliver') == expected, (chat, changed)
            assert changed['failure_deliver'] == (expected or 'origin'), (chat, changed)
        # A store it can't read refuses the create rather than saving a route that never delivers.
        set_session_vars(platform='local', chat_id=sid, session_id=sid, session_key='agent:main:local:' + sid,
                         source='', cron_session='')
        with patch.object(plugin.cron, '_sessions', side_effect=OSError('store unavailable')):
            block, _ = _dispatch_pre_tool_call_hooks('cronjob_manage', dict(action='create', schedule='every 1h'), session_id=sid)
        assert block, 'an unreadable store must refuse the create'
        set_session_vars(platform='', chat_id='', source='clawy', session_id=sid, session_key=sid, cron_session='')
        for value in ('', ' Origin ', ['origin']):
            args = dict(action=' Create ', deliver=value)
            changed = _dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)[1]
            assert changed['deliver'] == 'clawy:' + sid, changed
        args = dict(action='update', job_id='anything', deliver='origin')
        assert (_dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)[1] or args) == args
        # Updating a job that delivers to `local:<chat>` repairs it.
        args = dict(action='update', job_id='anything', deliver=['local:' + sid])
        assert _dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)[1]['deliver'] == 'clawy:' + sid
        # No YAML platform configuration: enabling this plugin is enough.
        (home / 'config.yaml').write_text('cron:\n  wrap_response: false\n')
        from cron.scheduler_preflight import _preflight_check_delivery
        job = dict(id='job', name='Safe reminder', deliver='clawy:' + sid, execution_id='run-1')
        assert _preflight_check_delivery(job) is None, _preflight_check_delivery(job)
        holder = '{"pid":' + str(os.getpid()) + '}'
        assert store.hold_turn(sid, holder)
        enqueue('run-1', job, 'Same result')
        assert drain(lambda j, text, failed: _deliver_result(j, text, adapters={}, for_failure=failed)) == 1
        assert get_status('run-1')['status'] == 'delivered'
        observer.cron.flush()
        assert len(db.get_messages(sid)) == 1, 'busy chat must wait'
        # A fresh plugin instance must recover the accepted result after a restart.
        observer.close()
        store.release_turn(sid, holder)
        plugin.register(ctx)
        observer = plugin._notifications
        observer.delivery.submit = alerts.append
        observer.cron.flush()
        rows = db.get_messages(sid)
        assert len(rows) == 2, rows
        assert rows[-1]['role'] == 'user' and rows[-1]['display_metadata']['clawy_automation'] is True
        assert rows[-1]['content'] == 'Same result'
        assert alerts[-1]['sessionKey'] == 'agent:default:' + sid and alerts[-1]['kind'] == 'reply'
        observer.cron.flush()
        assert len(db.get_messages(sid)) == 2
        # A second occurrence with identical words must remain a separate post.
        assert _deliver_result(dict(job, execution_id='run-2'), 'Same result', adapters={}) is None
        observer.cron.flush()
        assert len(db.get_messages(sid)) == 3
        # A crash after the note commits replays its admission, never the text twice.
        observer.cron._enqueue(sid, 'Crash recovery')
        original = notes.note
        def written_then_crashed(*args):
            original(*args)
            raise RuntimeError('simulated exit after note commit')
        with patch.object(notes, 'note', written_then_crashed):
            try:
                observer.cron.flush()
            except RuntimeError:
                pass
        assert len(db.get_messages(sid)) == 4
        observer.cron.flush()
        assert len(db.get_messages(sid)) == 4
        # Compression moves the physical transcript while the original delivery route stays stable.
        store.compress(sid, 'clawy-tip', 'Compacted handoff')
        assert _deliver_result(dict(job, execution_id='run-3'), 'After compression', adapters={}) is None
        observer.cron.flush()
        assert db.get_messages('clawy-tip')[-1]['content'] == 'After compression'
        assert alerts[-1]['sessionKey'] == 'agent:default:clawy-tip'
        # A sibling profile with the same session id writes only its own state and push route.
        sibling = home / 'profiles' / 'writer'
        sibling.mkdir(parents=True)
        other = acquire(sibling / 'state.db')
        other.create_session(sid, source='clawy')
        other_alerts = []
        sender = plugin.CronDelivery(sibling, lambda *args, **kwargs: other_alerts.append((args, kwargs)))
        assert asyncio.run(sender.send(None, sid, 'Writer only'))['success']
        sender.flush()
        assert other.get_messages(sid)[-1]['content'] == 'Writer only'
        assert db.get_messages('clawy-tip')[-1]['content'] == 'After compression'
        assert len(other_alerts) == 1
        # Jobs saved before the hook routed them name a Clawy chat through `local:`, directly or as
        # their origin. Each profile repairs its own store, and only those legs.
        from cron import jobs
        local = {'platform': 'local', 'chat_id': sid}
        saved = dict(origin=(dict(deliver='origin', origin=local), 'clawy:' + sid, None),
                     explicit=(dict(deliver='local:' + sid, failure_deliver='origin', origin=local), 'clawy:' + sid, 'clawy:' + sid),
                     mixed=(dict(deliver='origin,telegram:123', origin=local), f'clawy:{sid},telegram:123', None),
                     paused=(dict(deliver='origin', origin=local, paused=True), 'clawy:' + sid, None),
                     host=(dict(deliver='local', origin=local), 'local', None),
                     foreign=(dict(deliver='origin', origin=dict(local, chat_id='telegram-session')), 'origin', None),
                     telegram=(dict(deliver='origin', origin={'platform': 'telegram', 'chat_id': '123'}), 'origin', None),
                     missing=(dict(deliver='local:missing-session'), 'local:missing-session', None),
                     repeated=(dict(deliver='telegram:123,telegram:123'), None, None))
        made = {name: jobs.create_job('Safe result', 'every 1h', name=name, **fields)['id']
                for name, (fields, _, _) in saved.items()}
        # Records `update_job` would refuse (a past one-shot with no next run) or reschedule (a
        # recurring job with none) get only their route changed.
        for name, schedule in (('stale', {'kind': 'once', 'run_at': '2020-01-01T00:00:00+00:00', 'display': 'once'}),
                               ('unscheduled', None)):
            made[name] = jobs.create_job('Safe result', 'every 1h', name=name, deliver='origin', origin=local)['id']
            saved[name] = (None, 'clawy:' + sid, None)
            with jobs._jobs_lock():
                records = jobs.load_jobs()
                record = next(job for job in records if job['id'] == made[name])
                record.update(next_run_at=None, **({'schedule': schedule} if schedule else {}))
                jobs.save_jobs(records)
        with jobs.use_cron_store(sibling):
            writer_job = jobs.create_job('Safe result', 'every 1h', deliver='origin', origin=local)['id']
        before = {name: jobs.get_job(job_id) for name, job_id in made.items()}
        # Each process repairs as it loads the plugin, before the scheduler can claim a due job.
        with patch.object(plugin.CronDelivery, '_work', work):
            plugin.CronDelivery(sibling, lambda *args, **kwargs: None).close()
            assert {name: jobs.get_job(job_id) for name, job_id in made.items()} == before, 'a profile repaired another profile\'s jobs'
            with jobs.use_cron_store(sibling):
                assert jobs.get_job(writer_job)['deliver'] == 'clawy:' + sid
            # A busy job lock delays the repair, never the plugin's registration.
            held, release = threading.Event(), threading.Event()
            def hold():
                with jobs._jobs_lock():
                    held.set()
                    release.wait(10)
            holder = threading.Thread(target=hold)
            holder.start()
            assert held.wait(5)
            started = time.monotonic()
            fresh = plugin.CronDelivery(home, lambda *args, **kwargs: None)
            assert time.monotonic() - started < 4, 'a busy job lock held up registration'
            assert jobs.get_job(made['origin'])['deliver'] == 'origin'
            release.set()
            holder.join(5)
            assert fresh.first_pass.wait(10)
            fresh.close()
        for name, (_, deliver, failure) in saved.items():
            stored = jobs.get_job(made[name])
            deliver = deliver or before[name]['deliver']  # None: as stored, untouched
            assert (stored['deliver'], stored.get('failure_deliver') or None) == (deliver, failure), (name, stored)
            for key in ('enabled', 'state', 'schedule', 'next_run_at', 'origin', 'prompt'):
                assert stored.get(key) == before[name].get(key), (name, key, stored)
        settled = jobs.JOBS_FILE.stat().st_mtime_ns
        observer.cron.repair_jobs()
        assert jobs.JOBS_FILE.stat().st_mtime_ns == settled, 'a repaired store must not be rewritten'
        for job_id in made.values():
            jobs.remove_job(job_id)
        with patch.object(plugin.cron, '_sessions', side_effect=AssertionError('opened state.db with nothing to repair')):
            assert observer.cron.repair_jobs()
        sender.close()
        release_or_close(other)
        # Invalid and foreign targets must never get a note or push.
        for target in ('missing-session', 'telegram-session'):
            assert asyncio.run(observer.cron.send(None, target, 'Wrong chat')).get('error')
        assert len(db.get_messages('telegram-session')) == 0
        # Both scheduler lanes must preserve images; the live lane sends text and media separately.
        from gateway.config import load_gateway_config, Platform
        image = (home / 'chart.png').resolve()
        image.write_bytes(b'\x89PNG\r\n\x1a\n' + bytes(64))
        assert _deliver_result(dict(job, execution_id='image-standalone'), f'Chart\nMEDIA:{image}', adapters={}) is None
        observer.cron.flush()
        assert f'[Image attached at: {image}]' in db.get_messages('clawy-tip')[-1]['content']
        assert _deliver_result(dict(job, execution_id='image-only'), f'MEDIA:{image}', adapters={}) is None
        observer.cron.flush()
        assert f'[Image attached at: {image}]' in db.get_messages('clawy-tip')[-1]['content']
        assert alerts[-1]['body'] == 'Image', alerts[-1]
        assert str(image) not in alerts[-1]['body']
        loop = asyncio.new_event_loop()
        runner = threading.Thread(target=loop.run_forever)
        runner.start()
        config = load_gateway_config().platforms[Platform('clawy')]
        live = plugin.cron_adapter(observer.cron, config)
        try:
            asyncio.run_coroutine_threadsafe(live.connect(), loop).result(5)
            assert _deliver_result(dict(job, execution_id='image-live'), f'Live chart\nMEDIA:{image}',
                                   adapters={Platform('clawy'): live}, loop=loop) is None
            observer.cron.flush()
            last = db.get_messages('clawy-tip')[-2:]
            assert any('Live chart' in row['content'] for row in last)
            assert any(f'[Image attached at: {image}]' in row['content'] for row in last)
            assert not any("Couldn't deliver" in row['content'] for row in last)
        finally:
            loop.call_soon_threadsafe(loop.stop)
            runner.join(5)
            loop.close()
        # A failure on a later note cannot replay an earlier push.
        def fail_second(self, target, receipt, content):
            if content == 'Second':
                raise contention('injected write failure')
            return original(self, target, receipt, content)
        observer.cron._enqueue(sid, 'First')
        observer.cron._enqueue(sid, 'Second')
        before = len(alerts)
        stopped = 0
        with patch.object(notes, 'note', fail_second):
            for _ in range(3):
                try:
                    observer.cron.flush()
                except contention:  # A locked store stops the pass for every row.
                    stopped += 1
        assert stopped == 3, 'a locked store must end the pass, not wait on it again for each row'
        assert len(alerts) == before + 1, 'later failure replayed an earlier push'
        observer.cron.flush()
        assert len(alerts) == before + 2
        # A state-store write stall must not hold the inbox's writer lock.
        entered, resume = threading.Event(), threading.Event()
        observer.cron._enqueue(sid, 'Stalled')
        def stalled(*args, **kwargs):
            entered.set()
            assert resume.wait(10)
            return original(*args, **kwargs)
        with patch.object(notes, 'note', stalled):
            writer = threading.Thread(target=observer.cron.flush)
            writer.start()
            try:
                assert entered.wait(5)
                observer.cron._enqueue(sid, 'Accepted during stall')
            finally:
                resume.set()
                writer.join(10)
        observer.cron.flush()
        # Competing flushers append once and only the remover submits the push.
        observer.cron._enqueue(sid, 'Concurrent')
        barrier = threading.Barrier(2)
        errors = []
        def concurrent(*args, **kwargs):
            barrier.wait(5)
            return original(*args, **kwargs)
        def flush_thread():
            try:
                observer.cron.flush()
            except Exception as error:
                errors.append(error)
        before = len(alerts)
        with patch.object(notes, 'note', concurrent):
            writers = [threading.Thread(target=flush_thread) for _ in range(2)]
            for writer in writers: writer.start()
            for writer in writers: writer.join(10)
        assert not errors, errors
        assert len(alerts) == before + 1
        # An unexpected bad row cannot starve a later result.
        observer.cron._enqueue(sid, 'Poisoned')
        observer.cron._enqueue(sid, 'Still delivered')
        def poisoned(self, target, receipt, content):
            if content == 'Poisoned':
                raise RuntimeError('injected row-specific failure')
            return original(self, target, receipt, content)
        with patch.object(notes, 'note', poisoned):
            observer.cron.flush()
        assert db.get_messages('clawy-tip')[-1]['content'] == 'Still delivered'
        observer.cron.flush()
        # Empty inboxes never acquire the Hermes store or rewrite the inbox file.
        idle_mtime = observer.cron.file.stat().st_mtime_ns
        with patch.object(plugin.cron, '_sessions', side_effect=AssertionError('empty inbox opened state.db')):
            observer.cron.flush()
        assert observer.cron.file.stat().st_mtime_ns == idle_mtime
        observer.close()
        store.close()
        release_or_close(db)
        print('PASS: routing, job repair, queued sender, busy chat, restart, repeated output, push, foreign targets')


if __name__ == '__main__':
    if sys.argv[-1:] == ['probe']:
        probe()
    else:
        unittest.main()
