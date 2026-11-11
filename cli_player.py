import subprocess
import os
import select
import signal
import shutil
import sys

SONGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs")

current_player = None
current_playing_song = None
player_launch_in_progress = False
shutdown_signal = None
PLAYER_STOP_TIMEOUT = 1.0


def resolveAfplay():
    configured = os.environ.get("AFPLAY_PATH")
    candidates = [configured] if configured else ["afplay", "/usr/bin/afplay"]
    for candidate in candidates:
        executable = shutil.which(os.path.expanduser(candidate))
        if executable:
            return executable
    location = f" ({configured})" if configured else ""
    raise RuntimeError(f"afplay{location} was not found or is not executable. Set AFPLAY_PATH to its executable path.")


def refreshSongs(directory_path, songs, user_selection_index):
    selected_song = songs[user_selection_index] if 0 <= user_selection_index < len(songs) else None
    refreshed_songs = sorted([f for f in os.listdir(directory_path) if not f.startswith('.')])
    if selected_song in refreshed_songs:
        user_selection_index = refreshed_songs.index(selected_song)
    else:
        user_selection_index = max(0, min(user_selection_index, len(refreshed_songs) - 1))
    return refreshed_songs, user_selection_index


def listSongs(songs, user_selection_index=0, playing_song=None, playback_error=None):
    sys.stdout.write('\033[2J\033[H') # Clear screen
    if not songs:
        sys.stdout.write("No songs found in the songs folder.\r\n")
    for ind, song in enumerate(songs):
        if ind == user_selection_index:
            sys.stdout.write(f"> {song}\r\n")
        else:
            sys.stdout.write(f"  {song}\r\n")
    if playing_song:
        sys.stdout.write(f"\r\nPlaying: {playing_song}\r\n")
    if playback_error:
        sys.stdout.write(f"\r\nPlayback error: {playback_error}\r\n")
    sys.stdout.flush()
    return songs


def stopPlayback():
    global current_player, current_playing_song
    player = current_player
    if player is None:
        current_playing_song = None
        return

    try:
        if player.poll() is None:
            player.terminate()
            try:
                player.wait(timeout=PLAYER_STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                player.kill()
                player.wait(timeout=PLAYER_STOP_TIMEOUT)
    except ProcessLookupError:
        # The player exited between polling and signalling it.
        pass
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"Could not stop the current player: {error}") from error

    if current_player is player:
        current_player = None
        current_playing_song = None


def playSong(song_name, player_command):
    global current_player, current_playing_song, player_launch_in_progress
    stopPlayback()
    song_path = os.path.join(SONGS_DIR, song_name)
    # Use Popen instead of run so it doesn't block the UI
    player_launch_in_progress = True
    try:
        current_player = subprocess.Popen([player_command, song_path])
        current_playing_song = song_name
    except OSError as error:
        raise RuntimeError(f"Could not start afplay ({player_command}): {error}. Check AFPLAY_PATH and executable permissions.") from error
    finally:
        player_launch_in_progress = False
        # Record ownership before honoring a signal received during Popen.
        if shutdown_signal is not None:
            raise SystemExit(128 + shutdown_signal)
    return current_player


def pollPlayback():
    global current_player, current_playing_song
    if current_player is None:
        return False, None
    return_code = current_player.poll()
    if return_code is None:
        return False, None

    current_player = None
    current_playing_song = None
    if return_code == 0:
        return True, None
    reason = f"by signal {-return_code}" if return_code < 0 else f"with exit code {return_code}"
    return True, f"afplay stopped {reason}"


def shutdownForSignal(signum, _frame):
    global shutdown_signal
    if shutdown_signal is not None:
        return
    shutdown_signal = signum
    # Unwinding Popen before assignment could leave its child unowned.
    if not player_launch_in_progress:
        raise SystemExit(128 + signum)


def cleanupApplication(fd, old_settings, termios):
    cleanup_errors = []
    try:
        stopPlayback()
    except Exception as error:
        cleanup_errors.append(str(error))

    try:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
    except Exception as error:
        cleanup_errors.append(f"Could not restore terminal settings: {error}")

    for error in cleanup_errors:
        print(f"Shutdown error: {error}", file=sys.stderr)


def main():
    global shutdown_signal
    if sys.platform != "darwin":
        print(f"Setup error: This player requires macOS and afplay; detected {sys.platform}.", file=sys.stderr)
        return 1
    try:
        player_command = resolveAfplay()
    except RuntimeError as error:
        print(f"Setup error: {error}", file=sys.stderr)
        return 1
    if not sys.stdin.isatty():
        print("Setup error: Run this player in an interactive terminal.", file=sys.stderr)
        return 1

    import tty
    import termios

    user_selection_index = 0
    playback_error = None
    songs, user_selection_index = refreshSongs(SONGS_DIR, [], user_selection_index)
    listSongs(songs, user_selection_index, current_playing_song)
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    handled_signals = [signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT]
    previous_signal_handlers = {signum: signal.getsignal(signum) for signum in handled_signals}
    shutdown_signal = None
    for signum in handled_signals:
        signal.signal(signum, shutdownForSignal)

    try:
        tty.setraw(fd)
        while True:
            finished, completion_error = pollPlayback()
            if finished:
                playback_error = completion_error
                songs, user_selection_index = refreshSongs(SONGS_DIR, songs, user_selection_index)
                listSongs(songs, user_selection_index, current_playing_song, playback_error)

            readable, _, _ = select.select([fd], [], [], 0.1 if current_player is not None else None)
            if not readable:
                continue
            char = os.read(fd, 1)
            if char in (b'\x03', b''): # Ctrl+C or end of input
                return 0

            songs, user_selection_index = refreshSongs(SONGS_DIR, songs, user_selection_index)
            if char in (b'\r', b'\n') and songs:
                try:
                    playSong(songs[user_selection_index], player_command)
                    playback_error = None
                except RuntimeError as error:
                    playback_error = str(error)

            if char == b'\x1b':
                next_char = os.read(fd, 1)
                if next_char == b'[':
                    arrow_char = os.read(fd, 1)
                    if arrow_char == b'A': # Up Key
                        user_selection_index = max(0, user_selection_index - 1)
                    elif arrow_char == b'B' and songs: # Down Key
                        user_selection_index = min(len(songs) - 1, user_selection_index + 1)

            listSongs(songs, user_selection_index, current_playing_song, playback_error)
    finally:
        # Do not let a second shutdown signal interrupt child and terminal cleanup.
        for signum in handled_signals:
            signal.signal(signum, signal.SIG_IGN)
        try:
            cleanupApplication(fd, old_settings, termios)
        finally:
            for signum, previous_handler in previous_signal_handlers.items():
                signal.signal(signum, previous_handler)


if __name__ == "__main__":
    sys.exit(main())
