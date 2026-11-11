import contextlib
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


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TIMEOUT = 5
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT)

FAKE_EXECUTABLE = f"""#!{sys.executable}
import os
from pathlib import Path
import signal
import time

metadata = Path(__file__).name == 'afinfo'
if not metadata and os.environ.get('IGNORE_PLAYER_SIGTERM') == '1':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
marker = os.environ['METADATA_PIDS' if metadata else 'PLAYER_PIDS']
with open(marker, 'a') as output:
    output.write(str(os.getpid()) + '\\n')
while True:
    time.sleep(1)
"""

INTERRUPTED_LAUNCH = """import os
from pathlib import Path
import signal
import sys
import time
import cli_player

original_popen = cli_player.subprocess.Popen
def interrupted_popen(*args, **kwargs):
    child = original_popen(*args, **kwargs)
    deadline = time.monotonic() + 5
    marker = Path(os.environ['PLAYER_PIDS'])
    while not marker.exists() or not marker.read_text().strip():
        if time.monotonic() >= deadline:
            child.kill()
            child.wait()
            raise RuntimeError('Test player did not start')
        time.sleep(0.01)
    # Deliver a real signal after launch, but before ownership is recorded.
    signal.raise_signal(int(os.environ['INTERRUPT_LAUNCH_SIGNAL']))
    return child

cli_player.subprocess.Popen = interrupted_popen
sys.exit(cli_player.main())
"""

EXPLICIT_NODE_EXIT = """const { existsSync, readFileSync } = require('fs');
require('./cli_player.js');
const ready = setInterval(() => {
    const started = path => existsSync(path) && readFileSync(path, 'utf8').trim();
    if (started(process.env.PLAYER_PIDS) && started(process.env.METADATA_PIDS)) {
        clearInterval(ready);
        process.exit(7);
    }
}, 10);
"""


def wait_until(condition, message):
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError(message)


def process_running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # An orphaned zombie is no longer playing audio, even before it is reaped.
    status = subprocess.run(
        ['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True, timeout=TIMEOUT
    ).stdout.strip()
    return bool(status) and not status.startswith('Z')


def terminal_settings(fd):
    settings = termios.tcgetattr(fd)
    # macOS sets this transient input-retype flag when restoring canonical mode.
    settings[3] &= ~getattr(termios, 'PENDIN', 0)
    return settings


@unittest.skipUnless(sys.platform == 'darwin', 'The players require macOS')
class ShutdownTests(unittest.TestCase):
    @contextlib.contextmanager
    def player(
        self, language, expected_exit=0, pipe_input=False, ignore_sigterm=False,
        launch_signal=None, explicit_exit=False,
    ):
        if language == 'javascript' and not shutil.which('node'):
            self.skipTest('Node.js is not installed')

        with tempfile.TemporaryDirectory(prefix='cli-player-shutdown-') as directory:
            root = Path(directory)
            for filename in ('cli_player.js', 'cli_player.py'):
                shutil.copy2(PROJECT_ROOT / filename, root / filename)
            songs = root / 'songs'
            songs.mkdir()
            (songs / 'test.mp3').write_text('Fake executables do not decode this file.\n')
            tools = root / 'executables with spaces'
            tools.mkdir()
            for name in ('vlc', 'afinfo', 'afplay'):
                executable = tools / name
                executable.write_text(FAKE_EXECUTABLE)
                executable.chmod(0o755)

            environment = {
                **os.environ,
                'VLC_PATH': str(tools / 'vlc'),
                'AFINFO_PATH': str(tools / 'afinfo'),
                'AFPLAY_PATH': str(tools / 'afplay'),
                'PLAYER_PIDS': str(root / 'player.pids'),
                'METADATA_PIDS': str(root / 'metadata.pids'),
                'IGNORE_PLAYER_SIGTERM': '1' if ignore_sigterm else '0',
            }
            if language == 'javascript':
                entrypoint = 'cli_player.js'
                if explicit_exit:
                    entrypoint = 'exit.js'
                    (root / entrypoint).write_text(EXPLICIT_NODE_EXIT)
                command = [shutil.which('node'), str(root / entrypoint)]
            else:
                entrypoint = 'cli_player.py'
                if launch_signal is not None:
                    entrypoint = 'interrupted_launch.py'
                    (root / entrypoint).write_text(INTERRUPTED_LAUNCH)
                    environment['INTERRUPT_LAUNCH_SIGNAL'] = str(launch_signal)
                command = [sys.executable, str(root / entrypoint)]

            master, slave = (None, None) if pipe_input else pty.openpty()
            old_settings = None if pipe_input else terminal_settings(slave)
            with tempfile.TemporaryFile(mode='w+') as errors:
                process = subprocess.Popen(
                    command, stdin=subprocess.PIPE if pipe_input else slave,
                    stdout=subprocess.DEVNULL, stderr=errors, env=environment,
                    start_new_session=True,
                )

                def send(data):
                    if pipe_input:
                        process.stdin.write(data)
                        process.stdin.flush()
                    else:
                        os.write(master, data)

                def child_pids():
                    return [
                        int(pid)
                        for name in ('player.pids', 'metadata.pids')
                        if (root / name).exists()
                        for pid in (root / name).read_text().splitlines()
                    ]

                try:
                    if not pipe_input:
                        wait_until(
                            lambda: not termios.tcgetattr(slave)[3] & termios.ICANON,
                            'Player did not enable raw input',
                        )
                    send(b'\r')
                    wait_until(
                        lambda: len(child_pids()) == (2 if language == 'javascript' else 1),
                        'Playback/metadata processes did not start',
                    )
                    yield process, send, songs
                    exit_code = process.wait(timeout=TIMEOUT)
                    errors.seek(0)
                    self.assertEqual(exit_code, expected_exit, errors.read())
                    wait_until(
                        lambda: all(not process_running(pid) for pid in child_pids()),
                        f'Playback/metadata processes survived application exit: {child_pids()}',
                    )
                    if not pipe_input:
                        self.assertEqual(terminal_settings(slave), old_settings)
                finally:
                    # Each fixture has its own session; clean up survivors even on failure.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=TIMEOUT)
                    if process.stdin is not None:
                        process.stdin.close()
                    if master is not None:
                        os.close(master)
                        os.close(slave)

    def test_raw_ctrl_c(self):
        for language in ('javascript', 'python'):
            with self.subTest(language=language), self.player(language) as (_, send, _):
                send(b'\x03')

    def test_catchable_signals(self):
        for language in ('javascript', 'python'):
            for signum in SIGNALS:
                with self.subTest(language=language, signal=signum), self.player(
                    language, expected_exit=128 + signum,
                ) as (process, _, _):
                    process.send_signal(signum)

    def test_fatal_error(self):
        for language in ('javascript', 'python'):
            with self.subTest(language=language), self.player(language, expected_exit=1) as (_, send, songs):
                songs.rename(songs.with_name('saved-songs'))
                songs.touch()
                send(b'x')  # The next library refresh raises an unhandled error.

    def test_javascript_stdin_eof(self):
        with self.player('javascript', pipe_input=True) as (process, _, _):
            process.stdin.close()

    def test_javascript_exit_hook(self):
        with self.player('javascript', expected_exit=7, explicit_exit=True):
            pass

    def test_python_kill_escalation(self):
        with self.player('python', ignore_sigterm=True) as (_, send, _):
            send(b'\x03')

    def test_python_signal_during_launch(self):
        for signum in SIGNALS:
            with self.subTest(signal=signum), self.player(
                'python', expected_exit=128 + signum, launch_signal=signum,
            ):
                pass

    def test_python_second_signal_during_cleanup(self):
        with self.player(
            'python', expected_exit=128 + signal.SIGTERM, ignore_sigterm=True,
        ) as (process, _, _):
            process.send_signal(signal.SIGTERM)
            time.sleep(0.05)
            process.send_signal(signal.SIGINT)


if __name__ == '__main__':
    unittest.main()
