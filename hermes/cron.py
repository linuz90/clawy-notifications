"""Cron delivery into legacy dashboard chats (Hermes issue #83904, Clawy #206)."""

import asyncio
from contextlib import contextmanager
import logging
from pathlib import Path
import sqlite3
import threading
import uuid

LOG = logging.getLogger('clawy.notifications')


class CronDelivery:
    def __init__(self, home, notify):
        self.home = Path(home)
        self.file = self.home / 'clawy-cron.db'
        self.notify = notify
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.worker = threading.Thread(target=self._work, name='clawy-cron', daemon=True)
        self.worker.start()

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
        if (tool_name != 'cronjob_manage' or not isinstance(args, dict)
                or str(args.get('action', '')).strip().lower() != 'create'):
            return
        from gateway.session_context import get_session_env
        if (get_session_env('HERMES_SESSION_SOURCE') != 'clawy'
                or get_session_env('HERMES_CRON_SESSION')):
            return
        from tools.cronjob_job_args import _normalize_deliver_param
        delivery = _normalize_deliver_param(args.get('deliver'))
        if delivery is not None and delivery.lower() != 'origin':
            return
        session = get_session_env('HERMES_SESSION_KEY')
        if session:
            return {'action': 'modify', 'args': {'deliver': 'clawy:' + session}}

    @staticmethod
    def _target(db, session):
        original = db.get_session(session)
        if original is None or original.get('source') != 'clawy':
            raise ValueError('Target must be a Clawy chat in this profile')
        return db.get_compression_tip(session) or session

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
        except (ValueError, OSError, sqlite3.Error):
            return {'error': 'Clawy chat delivery could not be saved'}
        self.wake.set()
        return {'success': True, 'message_id': receipt, 'media_delivered': bool(media_files)}

    def _enqueue(self, session, content):
        from hermes_state_registry import acquire, release_or_close
        db = acquire(self.home / 'state.db')
        try:
            self._target(db, session)
        finally:
            release_or_close(db)
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
        from hermes_state_registry import acquire, release_or_close
        from hermes_state_errors import SessionTurnLeaseLostError, CompressionSessionClosedError
        db = acquire(self.home / 'state.db')
        try:
            for receipt, session, content in rows:
                if self.stopping.is_set():
                    break
                try:
                    target = self._target(db, session)
                    # Never hold the inbox lock while Hermes waits for its own store writer.
                    db.append_completion_note(target, receipt, content, 'internal_notification', {'clawy_automation': True})
                except (SessionTurnLeaseLostError, CompressionSessionClosedError):
                    continue
                except ValueError:
                    LOG.warning('Clawy cron target is no longer available')
                    self._remove(receipt)
                except sqlite3.OperationalError:
                    raise  # A busy store affects every row; retry on the next pass.
                except Exception:
                    LOG.warning('Clawy cron note is waiting for its store')
                    continue
                else:
                    # Idempotent notes let competing processes try the same row. Only the
                    # successful remover pushes; a crash after removal may lose the alert.
                    if self._remove(receipt):
                        self.notify('reply', target, title='Automation posted', body=self._preview(content)[:2048])
        finally:
            release_or_close(db)

    def _work(self):
        while not self.stopping.is_set():
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
