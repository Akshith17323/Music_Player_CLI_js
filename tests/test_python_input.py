import contextlib
import importlib.util
import os
from pathlib import Path
import pty
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest

from test_shutdown import TIMEOUT, process_running, terminal_settings, wait_until


PROJECT_ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cli_player', PROJECT_ROOT / 'cli_player.py')
cli_player = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli_player)

ARROWS = (b'\x1b[A', b'\x1b[B', b'\x1bOA', b'\x1bOB')
PREFIXES = (b'\x1b', b'\x1b[', b'\x1bO', b'\x1b[1;')

FAKE_AFPLAY = f"""#!{sys.executable}
import os
import signal
import sys
import time

signal.signal(signal.SIGUSR1, lambda *_: sys.exit(0))
with open(os.environ['PLAYER_LOG'], 'a') as output:
    output.write(str(os.getpid()) + ' ' + os.path.basename(sys.argv[1]) + '\\n')
while True:
    time.sleep(1)
"""


class KeyDecoderTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.decoder = cli_player.KeyDecoder(clock=lambda: self.now)

    def test_batched_independent_keys(self):
        self.assertEqual(self.decoder.feed(b'x\r\n\x03'), [b'x', b'\r', b'\n', b'\x03'])
        self.assertIsNone(self.decoder.timeout())

    def test_normal_and_application_arrows(self):
        self.assertEqual(self.decoder.feed(b''.join(ARROWS)), list(ARROWS))

    def test_arrows_fragmented_at_every_boundary(self):
        for arrow in ARROWS:
            for boundary in (1, 2):
                with self.subTest(arrow=arrow, boundary=boundary):
                    decoder = cli_player.KeyDecoder(clock=lambda: self.now)
                    self.assertEqual(decoder.feed(arrow[:boundary]), [])
                    self.now += cli_player.ESCAPE_TIMEOUT / 4
                    self.assertEqual(decoder.feed(arrow[boundary:]), [arrow])
                    self.assertIsNone(decoder.timeout())

    def test_timeout_restarts_for_each_fragment(self):
        for arrow in ARROWS:
            with self.subTest(arrow=arrow):
                decoder = cli_player.KeyDecoder(clock=lambda: self.now)
                for value in arrow[:-1]:
                    self.assertEqual(decoder.feed(bytes([value])), [])
                    self.now += cli_player.ESCAPE_TIMEOUT * 0.75
                self.assertEqual(decoder.feed(arrow[-1:]), [arrow])

    def test_standalone_escape_expires(self):
        self.assertEqual(self.decoder.feed(b'\x1b'), [])
        self.assertAlmostEqual(self.decoder.timeout(), cli_player.ESCAPE_TIMEOUT)
        self.now += cli_player.ESCAPE_TIMEOUT
        self.assertEqual(self.decoder.timeout(), 0)
        self.decoder.expire()
        self.assertIsNone(self.decoder.timeout())
        self.assertEqual(self.decoder.feed(b'\r\x03'), [b'\r', b'\x03'])

    def test_late_bytes_are_independent(self):
        for prefix in PREFIXES:
            with self.subTest(prefix=prefix):
                decoder = cli_player.KeyDecoder(clock=lambda: self.now)
                self.assertEqual(decoder.feed(prefix), [])
                self.now += cli_player.ESCAPE_TIMEOUT * 2
                self.assertEqual(decoder.feed(b'[B\r'), [b'[', b'B', b'\r'])
                self.assertIsNone(decoder.timeout())

    def test_commands_interrupt_incomplete_sequences(self):
        for prefix in PREFIXES:
            for command in (b'\r', b'\n', b'\x03'):
                for batched in (False, True):
                    with self.subTest(prefix=prefix, command=command, batched=batched):
                        decoder = cli_player.KeyDecoder(clock=lambda: self.now)
                        if batched:
                            keys = decoder.feed(prefix + command)
                        else:
                            self.assertEqual(decoder.feed(prefix), [])
                            self.now += cli_player.ESCAPE_TIMEOUT / 4
                            keys = decoder.feed(command)
                        self.assertEqual(keys, [command])
                        self.assertIsNone(decoder.timeout())

    def test_escape_does_not_consume_other_keys(self):
        self.assertEqual(self.decoder.feed(b'\x1bx\r'), [b'x', b'\r'])

    def test_new_escape_restarts_a_sequence(self):
        self.assertEqual(self.decoder.feed(b'\x1b\x1b[B\x1b[\x1bOA'), [b'\x1b[B', b'\x1bOA'])

    def test_unsupported_and_modified_sequences_are_ignored(self):
        self.assertEqual(self.decoder.feed(b'\x1b[C\x1b[D\x1b[1;5A\x1b[1;2B\x1bOP\x1b[99~'), [])
        self.assertEqual(self.decoder.feed(b'\r\x03'), [b'\r', b'\x03'])

    def test_overlong_sequence_recovers_for_commands(self):
        keys = self.decoder.feed(b'\x1b[' + b'1' * 1024 + b'\r\x03')
        self.assertEqual(keys[-2:], [b'\r', b'\x03'])
        self.assertIsNone(self.decoder.timeout())


@unittest.skipUnless(sys.platform == 'darwin', 'The player requires macOS')
class PythonInputTests(unittest.TestCase):
    @contextlib.contextmanager
    def player(self, empty=False):
        with tempfile.TemporaryDirectory(prefix='cli-player-input-') as directory:
            root = Path(directory)
            shutil.copy2(PROJECT_ROOT / 'cli_player.py', root / 'cli_player.py')
            songs = root / 'songs'
            songs.mkdir()
            if not empty:
                for name in ('a.mp3', 'b.mp3', 'c.mp3'):
                    (songs / name).write_text('The fake player does not decode audio.\n')
            executable = root / 'fake afplay'
            executable.write_text(FAKE_AFPLAY)
            executable.chmod(0o755)
            player_log = root / 'players.log'
            output_path = root / 'screen.log'
            environment = {
                **os.environ,
                'AFPLAY_PATH': str(executable),
                'PLAYER_LOG': str(player_log),
            }
            master, slave = pty.openpty()
            old_settings = terminal_settings(slave)
            with output_path.open('wb') as output, tempfile.TemporaryFile(mode='w+') as errors:
                process = subprocess.Popen(
                    [sys.executable, str(root / 'cli_player.py')], stdin=slave,
                    stdout=output, stderr=errors, env=environment, start_new_session=True,
                )

                def send(data):
                    os.write(master, data)

                def screen():
                    return output_path.read_bytes().rsplit(b'\x1b[2J\x1b[H', 1)[-1]

                def launches():
                    if not player_log.exists():
                        return []
                    return [
                        (int(pid), song)
                        for pid, song in (line.split(' ', 1) for line in player_log.read_text().splitlines())
                    ]

                try:
                    wait_until(
                        lambda: not termios.tcgetattr(slave)[3] & termios.ICANON,
                        'Player did not enable raw input',
                    )
                    yield process, send, screen, launches
                    if process.poll() is None:
                        send(b'\x03')
                    exit_code = process.wait(timeout=TIMEOUT)
                    errors.seek(0)
                    self.assertEqual(exit_code, 0, errors.read())
                    wait_until(
                        lambda: all(not process_running(pid) for pid, _ in launches()),
                        'Playback process survived application exit',
                    )
                    self.assertEqual(terminal_settings(slave), old_settings)
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=TIMEOUT)
                    os.close(master)
                    os.close(slave)

    def test_batched_escape_enter(self):
        with self.player() as (_, send, _, launches):
            send(b'\x1b\r')
            wait_until(lambda: bool(launches()), 'Enter after Escape did not start playback')
            self.assertEqual(launches()[0][1], 'a.mp3')

    def test_commands_after_escape(self):
        for prefix in PREFIXES:
            for command in (b'\r', b'\n', b'\x03'):
                for delay in (0, 0.1):
                    with self.subTest(prefix=prefix, command=command, delay=delay), self.player() as (
                        process, send, _, launches,
                    ):
                        if command == b'\x03':
                            send(b'\r')
                            wait_until(lambda: bool(launches()), 'Initial playback did not start')
                        if delay:
                            send(prefix)
                            time.sleep(delay)
                            send(command)
                        else:
                            send(prefix + command)
                        if command == b'\x03':
                            self.assertEqual(process.wait(timeout=TIMEOUT), 0)
                        else:
                            wait_until(lambda: bool(launches()), 'Enter after Escape was consumed')
                            self.assertEqual(launches()[0][1], 'a.mp3')

    def test_fragmented_arrows(self):
        for arrow in ARROWS:
            for boundary in (1, 2):
                with self.subTest(arrow=arrow, boundary=boundary), self.player() as (
                    _, send, screen, launches,
                ):
                    going_up = arrow.endswith(b'A')
                    if going_up:
                        send(b'\x1b[B')
                        wait_until(lambda: b'> b.mp3\r\n' in screen(), 'Initial navigation failed')
                    send(arrow[:boundary])
                    time.sleep(0.01)
                    send(arrow[boundary:])
                    expected_song = 'a.mp3' if going_up else 'b.mp3'
                    wait_until(
                        lambda: f'> {expected_song}\r\n'.encode() in screen(),
                        'Fragmented arrow did not move the selection',
                    )
                    send(b'\r')
                    wait_until(lambda: bool(launches()), 'Playback did not start')
                    self.assertEqual(launches()[0][1], expected_song)

    def test_batched_arrows_and_commands(self):
        with self.player() as (process, send, _, launches):
            send(b'\x1b[B\x1bOB\x1b[A\n')
            wait_until(lambda: bool(launches()), 'Batched Enter did not start playback')
            self.assertEqual(launches()[0][1], 'b.mp3')
            send(b'x\x03\r')
            self.assertEqual(process.wait(timeout=TIMEOUT), 0)
            self.assertEqual(len(launches()), 1)

    def test_expired_prefix_does_not_navigate(self):
        for prefix, suffix in ((b'\x1b', b'[B'), (b'\x1b[', b'B'), (b'\x1bO', b'B')):
            with self.subTest(prefix=prefix), self.player() as (_, send, _, launches):
                send(prefix)
                time.sleep(0.1)
                send(suffix + b'\r')
                wait_until(lambda: bool(launches()), 'Enter after an expired prefix was consumed')
                self.assertEqual(launches()[0][1], 'a.mp3')

    def test_completion_while_escape_pending(self):
        for prefix in (b'\x1b', b'\x1b['):
            with self.subTest(prefix=prefix), self.player() as (process, send, screen, launches):
                send(b'\r')
                wait_until(lambda: bool(launches()), 'Playback did not start')
                wait_until(lambda: b'Playing: a.mp3' in screen(), 'Playing status was not rendered')
                send(prefix)
                os.kill(launches()[0][0], signal.SIGUSR1)
                wait_until(lambda: b'Playing:' not in screen(), 'Escape blocked playback completion')
                self.assertIsNone(process.poll())
                self.assertNotIn(b'Playback error:', screen())

    def test_escape_commands_with_empty_library(self):
        with self.player(empty=True) as (process, send, _, launches):
            send(b'\x1b\r\x1b[\n\x1b\x03')
            self.assertEqual(process.wait(timeout=TIMEOUT), 0)
            self.assertEqual(launches(), [])


if __name__ == '__main__':
    unittest.main()
