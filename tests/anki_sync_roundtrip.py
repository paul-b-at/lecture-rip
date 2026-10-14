"""Real local-only Anki sync integration check; never contacts AnkiWeb."""
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from anki.collection import Collection
from anki.sync_pb2 import SyncCollectionResponse
from anki_sync import checked_sync
import push_cards

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'SYNC_HOST':'127.0.0.1', 'SYNC_PORT':str(port), 'SYNC_BASE':str(root/'server'), 'SYNC_USER1':'testuser:test-only-password'}
    with (root/'server.log').open('w') as server_log:
        server = subprocess.Popen([sys.executable, '-m', 'anki.syncserver'], env=env, stdout=server_log, stderr=server_log)
        collections = []
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError((root/'server.log').read_text()[-3000:])
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        break
                except OSError:
                    time.sleep(.1)
            endpoint = f'http://127.0.0.1:{port}/'
            def open_col(name):
                col=Collection(str(root/f'{name}.anki2'))
                collections.append(col)
                return col
            # Seed a throwaway server with one existing note. This explicit full
            # upload is TEST FIXTURE SETUP ONLY, not the production sync helper.
            seed = open_col('seed')
            note=seed.new_note(seed.models.by_name('Basic'))
            note.fields=['Existing remote note', 'Must be preserved']
            seed.add_note(note, seed.decks.id('Existing'))
            auth=seed.sync_login('testuser', 'test-only-password', endpoint=endpoint)
            auth.io_timeout_secs=5
            response=seed.sync_collection(auth, sync_media=False)
            assert response.required == SyncCollectionResponse.FULL_UPLOAD, response
            seed.close_for_full_sync()
            try:
                seed.full_upload_or_download(auth=auth, server_usn=None, upload=True)
            finally:
                seed.reopen(after_full_sync=True)
            seed.close()

            runner=open_col('runner')
            auth=runner.sync_login('testuser', 'test-only-password', endpoint=endpoint)
            auth.io_timeout_secs=5
            checked_sync(runner, auth, 'pull', allow_initial_download=True)
            assert runner.note_count()==1
            batch={'lectureId':'local-integration-test','lectureDate':'2026-10-14','courseSlug':'sync-test','cards':[
                {'type':'basic','front':'Basic integration test','back':'Answer','tags':['Problem Solving']},
                {'type':'mc','front':'MC integration test','back':'Explanation','options':['A','B'],'correct':0,'tags':[]},
                {'type':'cloze','front':'A {{c1::real}} sync test','back':'','tags':[]},
            ]}
            stats=push_cards.push_batch_to_collection(runner,batch)
            assert stats == {'added':3,'skipped':0,'failed':0}, stats
            checked_sync(runner,auth,'push')
            # A subsequent pull/push reuses the collection without duplicating notes.
            checked_sync(runner,auth,'pull',allow_initial_download=True)
            assert push_cards.push_batch_to_collection(runner,batch) == {'added':0,'skipped':3,'failed':0}
            checked_sync(runner,auth,'push')
            runner.close()

            reader=open_col('reader')
            reader_auth=reader.sync_login('testuser', 'test-only-password', endpoint=endpoint)
            reader_auth.io_timeout_secs=5
            checked_sync(reader,reader_auth,'pull',allow_initial_download=True)
            assert reader.note_count()==4, reader.note_count()
            for card in batch['cards']:
                assert push_cards.guid_exists(reader,push_cards.note_guid(batch['lectureId'],card['front']))
            assert reader.find_notes('"Existing remote note"')
            print('PASS: empty runner bootstrapped, preserved existing note, pushed Basic/MC/Cloze; separate client received all 4 notes.')
        except Exception:
            print('Local server log tail:', (root/'server.log').read_text()[-2000:])
            raise
        finally:
            for col in collections:
                try: col.close()
                except Exception: pass
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()
