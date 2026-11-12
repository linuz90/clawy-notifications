"""Real Hermes contracts, isolated from any paired home. Set CLAWY_HERMES_SOURCE to run."""
import asyncio
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import threading
from unittest.mock import patch
import tempfile
import unittest


class CronContractTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('CLAWY_HERMES_SOURCE'), 'Set CLAWY_HERMES_SOURCE to the Hermes source checkout')
    def test_scheduled_results_and_routing(self):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), 'probe'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


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
        plugin.CronDelivery._work = lambda _: None
        manager = get_plugin_manager()
        manager.discover_and_load()
        ctx = PluginContext(PluginManifest(name='clawy-contract', key='clawy-contract', source='user'), manager)
        plugin.register(ctx)
        assert _is_known_delivery_platform('clawy'), 'cron preflight must recognize the platform'
        observer = plugin._notifications
        alerts = []
        observer.delivery.submit = alerts.append
        db = acquire(home / 'state.db')
        sid = 'clawy-original'
        db.create_session(sid, source='clawy')
        db.append_message(sid, 'user', content='Schedule this')
        db.create_session('telegram-session', source='telegram')
        for source in ('telegram', 'dashboard', 'cli', 'clawy'):
            set_session_vars(source=source, session_id=sid, session_key=sid, cron_session='')
            for delivery in (None, 'origin', 'local', 'telegram:123', 'origin,telegram:123'):
                args = dict(action='create', prompt='Safe result', schedule='every 1h')
                if delivery is not None:
                    args['deliver'] = delivery
                block, changed = _dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)
                changed = changed or args
                expected = 'clawy:' + sid if source == 'clawy' and delivery in (None, 'origin') else delivery
                assert changed.get('deliver') == expected, (source, delivery, changed)
                assert changed['prompt'] == args['prompt'] and block is None
        set_session_vars(source='clawy', session_id=sid, session_key=sid, cron_session='')
        for value in ('', ' Origin ', ['origin']):
            args = dict(action=' Create ', deliver=value)
            changed = _dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)[1]
            assert changed['deliver'] == 'clawy:' + sid, changed
        args = dict(action='update', job_id='anything', deliver='origin')
        assert (_dispatch_pre_tool_call_hooks('cronjob_manage', args, session_id=sid)[1] or args) == args
        # No YAML platform configuration: enabling this plugin is enough.
        (home / 'config.yaml').write_text('cron:\n  wrap_response: false\n')
        from cron.scheduler_preflight import _preflight_check_delivery
        job = dict(id='job', name='Safe reminder', deliver='clawy:' + sid, execution_id='run-1')
        assert _preflight_check_delivery(job) is None, _preflight_check_delivery(job)
        holder = '{"pid":' + str(os.getpid()) + '}'
        assert db.try_acquire_session_turn_lease(sid, holder)
        enqueue('run-1', job, 'Same result')
        assert drain(lambda j, text, failed: _deliver_result(j, text, adapters={}, for_failure=failed)) == 1
        assert get_status('run-1')['status'] == 'delivered'
        observer.cron.flush()
        assert len(db.get_messages(sid)) == 1, 'busy chat must wait'
        # A fresh plugin instance must recover the accepted result after a restart.
        observer.close()
        db.release_session_turn_lease(sid, holder)
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
        original_append = db.append_completion_note
        def written_then_crashed(*args, **kwargs):
            original_append(*args, **kwargs)
            raise RuntimeError('simulated exit after note commit')
        with patch.object(db, 'append_completion_note', side_effect=written_then_crashed):
            try:
                observer.cron.flush()
            except RuntimeError:
                pass
        assert len(db.get_messages(sid)) == 4
        observer.cron.flush()
        assert len(db.get_messages(sid)) == 4
        # Compression moves the physical transcript while the original delivery route stays stable.
        holder = 'compression-test'
        assert db.try_acquire_compression_lock(sid, holder)
        db.publish_compression_child(parent_session_id=sid, child_session_id='clawy-tip', source='clawy',
                                     messages=[{'role': 'user', 'content': 'Compacted handoff'}], compression_lock_holder=holder)
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
        original = db.append_completion_note
        def fail_second(target, receipt, content, *args):
            if content == 'Second':
                raise __import__('sqlite3').OperationalError('injected write failure')
            return original(target, receipt, content, *args)
        observer.cron._enqueue(sid, 'First')
        observer.cron._enqueue(sid, 'Second')
        before = len(alerts)
        with patch.object(db, 'append_completion_note', side_effect=fail_second):
            for _ in range(3):
                try:
                    observer.cron.flush()
                except __import__('sqlite3').OperationalError:
                    pass
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
        with patch.object(db, 'append_completion_note', side_effect=stalled):
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
        with patch.object(db, 'append_completion_note', side_effect=concurrent):
            writers = [threading.Thread(target=flush_thread) for _ in range(2)]
            for writer in writers: writer.start()
            for writer in writers: writer.join(10)
        assert not errors, errors
        assert len(alerts) == before + 1
        # An unexpected bad row cannot starve a later result.
        observer.cron._enqueue(sid, 'Poisoned')
        observer.cron._enqueue(sid, 'Still delivered')
        def poisoned(target, receipt, content, *args):
            if content == 'Poisoned':
                raise RuntimeError('injected row-specific failure')
            return original(target, receipt, content, *args)
        with patch.object(db, 'append_completion_note', side_effect=poisoned):
            observer.cron.flush()
        assert db.get_messages('clawy-tip')[-1]['content'] == 'Still delivered'
        observer.cron.flush()
        # Empty inboxes never acquire the Hermes store or rewrite the inbox file.
        idle_mtime = observer.cron.file.stat().st_mtime_ns
        with patch('hermes_state_registry.acquire', side_effect=AssertionError('empty inbox opened state.db')):
            observer.cron.flush()
        assert observer.cron.file.stat().st_mtime_ns == idle_mtime
        observer.close()
        release_or_close(db)
        print('PASS: routing, queued sender, busy chat, restart, repeated output, push, foreign targets')


if __name__ == '__main__':
    if sys.argv[-1:] == ['probe']:
        probe()
    else:
        unittest.main()
