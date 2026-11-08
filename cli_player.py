import subprocess
import os
import shutil
import sys

SONGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs")

current_player = None
current_playing_song = None


def resolveAfplay():
    configured = os.environ.get("AFPLAY_PATH")
    candidates = [configured] if configured else ["afplay", "/usr/bin/afplay"]
    for candidate in candidates:
        executable = shutil.which(os.path.expanduser(candidate))
        if executable:
            return executable
    location = f" ({configured})" if configured else ""
    raise RuntimeError(f"afplay{location} was not found or is not executable. Set AFPLAY_PATH to its executable path.")


def listSongs(directory_path, user_selection_index=0, playing_song=None, playback_error=None):
    sys.stdout.write('\033[2J\033[H') # Clear screen
    songs = sorted([f for f in os.listdir(directory_path) if not f.startswith('.')])
    user_selection_index = max(0, min(user_selection_index, len(songs) - 1))
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


def playSong(song_name, player_command):
    global current_player, current_playing_song
    try:
        if current_player:
            current_player.terminate()
    except OSError as error:
        raise RuntimeError(f"Could not stop the current player: {error}") from error

    current_player = None
    current_playing_song = None
    song_path = os.path.join(SONGS_DIR, song_name)
    # Use Popen instead of run so it doesn't block the UI
    try:
        current_player = subprocess.Popen([player_command, song_path])
    except OSError as error:
        raise RuntimeError(f"Could not start afplay ({player_command}): {error}. Check AFPLAY_PATH and executable permissions.") from error
    current_playing_song = song_name
    return current_player


def main():
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
    songs = listSongs(SONGS_DIR, user_selection_index, current_playing_song)
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)

    try:
        tty.setraw(fd)
        while True:
            char = sys.stdin.read(1)
            if char in ('\x03', ''): # Ctrl+C or end of input
                return 0

            if char in ('\r', '\n') and songs:
                try:
                    playSong(songs[user_selection_index], player_command)
                    playback_error = None
                except RuntimeError as error:
                    playback_error = str(error)

            if char == '\x1b':
                next_char = sys.stdin.read(1)
                if next_char == '[':
                    arrow_char = sys.stdin.read(1)
                    if arrow_char == 'A': # Up Key
                        user_selection_index = max(0, user_selection_index - 1)
                    elif arrow_char == 'B' and songs: # Down Key
                        user_selection_index = min(len(songs) - 1, user_selection_index + 1)

            songs = listSongs(SONGS_DIR, user_selection_index, current_playing_song, playback_error)
            user_selection_index = max(0, min(user_selection_index, len(songs) - 1))
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


if __name__ == "__main__":
    sys.exit(main())
