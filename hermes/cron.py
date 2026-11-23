"""Cron delivery into the profile's chats as Clawy shows them (Hermes issue #83904, Clawy #206, #657)."""

import asyncio
from contextlib import contextmanager
import json
import logging
from pathlib import Path
import sqlite3
import threading
import time
import uuid

LOG = logging.getLogger('clawy.notifications')


def _deliver_text(value):
    """`deliver` as one comma-separated string, None when empty. Hermes's own normalizer moved
    (`tools.cronjob_job_args` up to 0.22, `cron.job_args` from 0.23), so it isn't imported."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = ','.join(str(item).strip() for item in value if str(item).strip())
    return str(value).strip() or None


def _rerouted(delivery, origin_chat, is_clawy):
    """*delivery* with each leg that names a Clawy chat through Hermes's own `local:<chat>` lane
    sent to `clawy:<chat>` instead, or None when nothing changes. That lane needs a gateway receipt,
    which a dashboard chat never gets: a result for a Clawy chat fails at every fire with
    `_ReceiptRefused('storage_unavailable')`. This platform writes the same note. *origin_chat* is
    the Clawy chat an `origin` leg means, if any."""
    parts = [part.strip() for part in delivery.split(',')]

    def leg(part):
        if origin_chat and part.lower() == 'origin':
            return 'clawy:' + origin_chat
        chat = part[6:].strip() if part[:6].lower() == 'local:' else ''
        return 'clawy:' + chat if chat and is_clawy(chat) else part

    legs = [leg(part) for part in parts]
    # Two legs can now name the same chat; legs it didn't reroute stay exactly as given.
    return ','.join(dict.fromkeys(legs)) if legs != parts else None


def _names_local(job):
    """Whether a leg of *job* could reach a chat through Hermes's `local:` lane, judged without the
    session store."""
    origin = job.get('origin') if isinstance(job.get('origin'), dict) else {}
    local_origin = str(origin.get('platform') or '').strip().lower() == 'local'
    legs = ','.join(_deliver_text(job.get(key)) or '' for key in ('deliver', 'failure_deliver'))
    return any(leg.startswith('local:') or (local_origin and leg == 'origin')
               for leg in (part.strip().lower() for part in legs.split(',')))


@contextmanager
def _sessions(home):
    """The profile's session store. Hermes 0.23 moved sessions behind its storage interface and
    left `SessionDB` without the compression and completion-note methods this plugin needs."""
    try:
        from persistence_assembly import open_persistence, profile_scope
    except ImportError:
        from hermes_state_registry import acquire, release_or_close
        db = acquire(home / 'state.db')
        try:
            yield _LegacySessions(db)
        finally:
            release_or_close(db)
        return
    store = open_persistence(profile_scope(home=home))
    try:
        yield _Sessions(store)
    finally:
        store.close()


class _Sessions:
    """Hermes 0.23 and later."""

    def __init__(self, store):
        from persistence import CompressionClosed, StoreContention, TurnLeaseLost
        self.store, self.busy = store, (TurnLeaseLost, CompressionClosed)
        # Hermes 0.23 reports a locked store as StoreContention rather than SQLite's own error.
        self.contention = (StoreContention, sqlite3.OperationalError)

    def source(self, session):
        row = self.store.sessions.list_row(session)
        return row.source if row is not None else None

    def listed(self, session):
        row = self.store.sessions.list_row(session)
        if row is None:
            return False
        # The list row leaves out `model_config`, which marks a delegate child.
        delegated = self.store.sessions.get_model_config_value(session, '_delegate_from')
        return _is_listed(row.source, row.hidden, {'_delegate_from': delegated})

    def tip(self, session):
        return self.store.lineage.tip(session)

    def local_target(self, session):
        bindings = self.store.bindings
        owner = bindings.lineage_owner(session)
        if bindings.binding_marks(owner).policy:
            return bindings.validate_lineage(bindings.receipt(owner))

    def note(self, session, receipt, content):
        self.store.messages.append_completion_note(session, receipt, content, 'internal_notification', {'clawy_automation': True})


class _LegacySessions:
    """Hermes 0.22."""

    def __init__(self, db):
        from hermes_state_errors import CompressionSessionClosedError, SessionTurnLeaseLostError
        self.db, self.busy = db, (SessionTurnLeaseLostError, CompressionSessionClosedError)
        self.contention = (sqlite3.OperationalError,)

    def source(self, session):
        row = self.db.get_session_list_row(session)
        return row.get('source') if row is not None else None

    def listed(self, session):
        row = self.db.get_session_list_row(session)
        if row is None:
            return False
        # The list row leaves out `model_config`, which marks a delegate child.
        return _is_listed(row.get('source'), row.get('hidden'), (self.db.get_session(session) or {}).get('model_config'))

    def tip(self, session):
        return self.db.get_compression_tip(session) or session

    def local_target(self, session):
        try:
            from hermes_state_local import local_lineage_owner
            from hermes_state_local_lineage import local_physical_target
        except ImportError:
            return None  # Classic builds predate the canonical local binding.
        with self.db._read_ctx() as conn:
            target = local_physical_target(conn, local_lineage_owner(conn, session))
        return target if target != session else None

    def note(self, session, receipt, content):
        self.db.append_completion_note(session, receipt, content, 'internal_notification', {'clawy_automation': True})


# Sessions Hermes runs for its own work, which Clawy doesn't list as chats.
_INTERNAL_SOURCES = frozenset({'cron', 'subagent', 'sub_agent', 'delegate', 'kanban'})


def _is_listed(source, hidden, model_config=None):
    """A session with this stored source, visibility and creation config is a chat Clawy lists, begun
    on any surface: an automation asked for from Clawy in a terminal or Telegram chat posts there too
    (Clawy #657). Hidden ones (a bot's room) and Hermes's own work stay out, as they do of Clawy's
    list, a delegate child too, which keeps its parent's source and says so in `model_config`."""
    if isinstance(model_config, str):
        try:
            model_config = json.loads(model_config)
        except ValueError:
            model_config = None
    delegated = isinstance(model_config, dict) and bool(model_config.get('_delegate_from'))
    return not hidden and not delegated and source not in _INTERNAL_SOURCES


class NotClawyChat(Exception):
    """The target is no chat of this profile; store errors never mean this."""


class CronDelivery:
    def __init__(self, home, notify):
        self.home = Path(home)
        self.file = self.home / 'clawy-cron.db'
        self.notify = notify
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.repaired, self.first_pass = False, threading.Event()
        self.worker = threading.Thread(target=self._work, name='clawy-cron', daemon=True)
        self.worker.start()
        # Let the first job repair land before Hermes's scheduler can claim a due job on the broken
        # route (a one-shot fires once), but never hold up registration on a busy job lock: Hermes
        # drops a plugin whose registration takes 10 s, and its job lock can wait 30.
        self.first_pass.wait(2)

    def close(self):
        self.stopping.set()
        self.wake.set()
        self.worker.join(timeout=5)

    @contextmanager
    def _connect(self):
        # No output is kept after delivery. Independent dashboard/profile plugin hosts can
        # share this inbox; removal elects the one process that submits the push.
        conn = sqlite3.connect(self.file, timeout=5)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def before_tool(self, tool_name='', args=None, **_):
        if tool_name != 'cronjob_manage' or not isinstance(args, dict):
            return
        action = str(args.get('action', '')).strip().lower()
        if action not in ('create', 'update'):
            return
        try:
            changes = {key: routed for key in ('deliver', 'failure_deliver')
                       if (routed := self._route(action, key, args.get(key))) is not None}
        except Exception:
            # Saved unrouted, the job could keep a `local:<chat>` route that never delivers.
            LOG.warning('Clawy could not check a delivery target')
            return {'action': 'block', 'message': "Couldn't check whether this job delivers to a Clawy chat, "
                                                  'so it was not saved. Try again in a moment.'}
        if changes:
            return {'action': 'modify', 'args': changes}

    def _route(self, action, key, value):
        """*key*'s value routed into Clawy, or None to leave it as requested."""
        delivery = _deliver_text(value)
        if delivery is None:
            chat = self._current_chat() if key == 'deliver' and action == 'create' else None
            return 'clawy:' + chat if chat else None
        # On update, `origin` means the job's stored origin, not the chat the update comes from;
        # `repair_jobs` fixes a stored one.
        here = action == 'create' and any(part.strip().lower() == 'origin' for part in delivery.split(','))
        return _rerouted(delivery, self._current_chat() if here else None, self._is_clawy)

    def _current_chat(self):
        from gateway.session_context import get_session_env
        if get_session_env('HERMES_CRON_SESSION'):
            return None
        if get_session_env('HERMES_SESSION_SOURCE') == 'clawy':
            return get_session_env('HERMES_SESSION_KEY') or None
        # A Clawy chat's turn the gateway runs itself (a prompt forwarded to the owner while it
        # holds work for the chat) names it as a Hermes local chat and sets no source, so Hermes
        # would store `origin` as `local:<chat>`, the lane above that never delivers.
        platform, chat = get_session_env('HERMES_SESSION_PLATFORM'), get_session_env('HERMES_SESSION_CHAT_ID')
        if platform == 'local' and chat and self._is_clawy(chat):
            return chat
        # A dashboard prompt names no delivery lane: no platform, no chat id, the chat's stored id as
        # its session key, and the dashboard tab that sent it (an editor's ACP turn names none). That's
        # a message sent from Clawy in a chat begun on another surface (the terminal, a messaging app),
        # or in a Clawy chat Hermes resumed without its source; Hermes's own TUI and Desktop prompts
        # look the same. Hermes would save `origin` with no origin, which goes to the profile's home
        # channel or nowhere, though its cronjob tool tells the model a local chat's default writes the
        # result into that chat, so the result goes there (Clawy #657).
        session = get_session_env('HERMES_SESSION_KEY')
        if (not platform and not chat and session and get_session_env('HERMES_UI_SESSION_ID')
                and self._is_chat(session)):
            return session
        return None

    def _is_clawy(self, session):
        with _sessions(self.home) as state:
            return state.source(session) == 'clawy'

    def _is_chat(self, session):
        with _sessions(self.home) as state:
            return state.listed(session)

    def repair_jobs(self):
        """Point this profile's jobs saved before the hook routed them (0.4.8) at `clawy:<chat>`:
        one made in a Clawy chat's gateway-run turn, or told `local:<chat>`, names the chat through
        Hermes's `local:` lane and never delivers. Only legs naming a Clawy chat of this profile change.
        False when the pass must run again: an edit since the first read named a chat not looked up."""
        try:
            from cron import jobs
            pinned, lock, load, save = jobs.use_cron_store, jobs._jobs_lock, jobs.load_jobs, jobs.save_jobs
        except (ImportError, AttributeError):
            # Unpinned, this process could edit another profile's jobs; unlocked, lose an edit.
            return True
        with pinned(self.home):
            if not any(_names_local(job) for job in load()):
                return True  # The usual case, without opening the session store.
            known = {}
            with _sessions(self.home) as state:

                def look_up(chat):
                    if chat not in known:
                        known[chat] = state.source(chat) == 'clawy'
                    return known[chat]

                # Look the chats up first, so Hermes's job lock is never held across store reads.
                if not any([self._repairs(job, look_up) for job in load()]):
                    return True
            missed = set()

            def cached(chat):
                if chat not in known:
                    missed.add(chat)
                return known.get(chat, False)

            with lock():
                # Read again under the lock, keeping an edit that landed since, and change only the
                # route fields: `update_job` would also re-derive the schedule (on the launch
                # profile's clock) and refuse a stale record, stopping the pass there.
                records = load()
                repaired = 0
                for job in records:
                    changes = self._repairs(job, cached)
                    job.update(changes)
                    repaired += bool(changes)
                if self.stopping.is_set():  # Never write after the plugin unloaded.
                    repaired = 0
                if repaired:
                    save(records)
        if repaired:
            LOG.info('Clawy pointed %d automation(s) back at their chat', repaired)
        return not missed

    def _try_repair(self):
        try:
            return self.repair_jobs()
        except Exception:
            LOG.warning('Clawy could not check automations for a broken chat route')
            return False

    @staticmethod
    def _repairs(job, is_clawy):
        origin = job.get('origin') if isinstance(job.get('origin'), dict) else {}
        chat = str(origin.get('chat_id') or '').strip() if str(origin.get('platform') or '').strip().lower() == 'local' else ''
        origin_chat = chat if chat and is_clawy(chat) else None
        changes = {}
        for key in ('deliver', 'failure_deliver'):
            delivery = _deliver_text(job.get(key))
            routed = _rerouted(delivery, origin_chat, is_clawy) if delivery else None
            if routed:
                changes[key] = routed
        return changes

    @staticmethod
    def _target(state, session):
        if not state.listed(session):
            raise NotClawyChat('Target must be a chat in this profile')
        # A local reset moves the transcript without extending its compression chain.
        # Read the same stored binding as Hermes's local lane (README, What could break).
        try:
            target = state.local_target(session)
        except Exception:
            # A binding Hermes can't validate here (a receipt behind a compression its classic build
            # made, say) falls back to compression lineage, which delivered before this lookup existed.
            target = None
        if target is None:
            return state.tip(session)
        if target != session and not state.listed(target):
            raise NotClawyChat('Target must be a chat in this profile')
        return target

    async def send(self, pconfig, chat_id, message, *, thread_id=None, media_files=None, **_):
        # Hermes's durable scheduler queue invokes the sender without an execution identity.
        # Give EACH invocation an admission id: equal text on recurring fires is not a retry.
        # The scheduler itself never replays a claimed send; our own restarts replay this id.
        if thread_id:
            return {'error': 'Clawy chats have no delivery threads'}
        content = message
        for item in media_files or ():
            file = item[0] if isinstance(item, (tuple, list)) else item
            if Path(file).suffix.lower() in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'):
                content += f'\n\n[Image attached at: {file}]'
            else:
                content += f'\n\nAttachment saved on the Hermes host: {file}'
        try:
            receipt = await asyncio.to_thread(self._enqueue, chat_id, content)
        except NotClawyChat:
            return {'error': 'Clawy chat delivery could not be saved'}
        except Exception:
            LOG.warning('Clawy cron result could not be saved')
            return {'error': 'Clawy chat delivery could not be saved'}
        self.wake.set()
        return {'success': True, 'message_id': receipt, 'media_delivered': bool(media_files)}

    def _enqueue(self, session, content):
        with _sessions(self.home) as state:
            self._target(state, session)
        receipt = 'clawy-cron-' + uuid.uuid4().hex
        self.file.touch(mode=0o600, exist_ok=True)
        self.file.chmod(0o600)
        with self._connect() as conn:
            conn.execute('CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, session TEXT NOT NULL, content TEXT NOT NULL)')
            conn.execute('INSERT INTO pending VALUES (?, ?, ?)', (receipt, session, content))
        return receipt

    def _remove(self, receipt):
        with self._connect() as conn:
            conn.execute('PRAGMA secure_delete = ON')
            return conn.execute('DELETE FROM pending WHERE id = ?', (receipt,)).rowcount > 0

    @staticmethod
    def _preview(content):
        lines = content.splitlines()
        image = any(line.startswith('[Image attached at: ') for line in lines)
        text = '\n'.join(line for line in lines if not line.startswith(
            ('[Image attached at: ', 'Attachment saved on the Hermes host: '))).strip()
        return text or ('Image' if image else 'Attachment')

    def flush(self):
        if not self.file.exists():
            return
        with self._connect() as conn:
            rows = conn.execute('SELECT id, session, content FROM pending ORDER BY rowid').fetchall()
        if not rows:
            return
        with _sessions(self.home) as state:
            for receipt, session, content in rows:
                if self.stopping.is_set():
                    break
                try:
                    target = self._target(state, session)
                    # Never hold the inbox lock while Hermes waits for its own store writer.
                    state.note(target, receipt, content)
                except state.busy:
                    continue
                except NotClawyChat:
                    LOG.warning('Clawy cron target is no longer available')
                    self._remove(receipt)
                except state.contention:
                    raise  # A busy store affects every row; retry on the next pass.
                except Exception:
                    LOG.warning('Clawy cron note is waiting for its store')
                    continue
                else:
                    # Idempotent notes let competing processes try the same row. Only the
                    # successful remover pushes; a crash after removal may lose the alert.
                    if self._remove(receipt):
                        self.notify('reply', target, title='Automation posted', body=self._preview(content)[:2048])

    def _work(self):
        self.repaired = self._try_repair()
        self.first_pass.set()
        retry_at = time.monotonic() + 60
        while not self.stopping.is_set():
            if not self.repaired and time.monotonic() >= retry_at:
                self.repaired, retry_at = self._try_repair(), time.monotonic() + 60
            self.wake.wait(1)
            self.wake.clear()
            if self.stopping.is_set():
                return
            try:
                self.flush()
            except Exception:
                LOG.warning('Clawy cron delivery is waiting for its store')


def adapter(delivery, config):
    # Hermes starts every enabled platform, including a send-only one. Use the same
    # durable sender in the live lane instead of a missing adapter and startup error.
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult

    class ClawyAdapter(BasePlatformAdapter):
        async def connect(self, *, is_reconnect=False):
            self._mark_connected()
            return True

        async def disconnect(self):
            self._mark_disconnected()

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            result = await delivery.send(config, chat_id, content)
            return SendResult(success=result.get('success', False),
                              message_id=result.get('message_id'), error=result.get('error'))

        async def _media(self, chat_id, file, caption):
            result = await delivery.send(config, chat_id, caption or '', media_files=[(file, False)])
            return SendResult(success=result.get('success', False),
                              message_id=result.get('message_id'), error=result.get('error'))

        async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._media(chat_id, image_path, caption)

        async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
            return await self._media(chat_id, file_path, caption)

        async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._media(chat_id, video_path, caption)

        async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
            return await self._media(chat_id, audio_path, caption)

        async def get_chat_info(self, chat_id):
            return {'name': 'Clawy chat', 'type': 'dm'}

    return ClawyAdapter(config, Platform('clawy'))
