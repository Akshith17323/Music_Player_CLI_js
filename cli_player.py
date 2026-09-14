import subprocess
import os
import sys
import tty
import termios

SONGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs")

current_player = None
current_playing_song = None


def listSongs(directory_path, user_selection_index=0, playing_song=None):
    sys.stdout.write('\033[2J\033[H') # Clear screen
    songs = sorted([f for f in os.listdir(directory_path) if not f.startswith('.')])
    for ind, song in enumerate(songs):
        if ind == user_selection_index:
            sys.stdout.write(f"> {song}\r\n")
        else:
            sys.stdout.write(f"  {song}\r\n")
    if playing_song:
        sys.stdout.write(f"\r\nPlaying: {playing_song}\r\n")
    sys.stdout.flush()
    return songs


def playSong(song_name):
    global current_player
    if current_player:
        current_player.terminate()
        
    song_path = os.path.join(SONGS_DIR,song_name)
    # Use Popen instead of run so it doesn't block the UI
    current_player = subprocess.Popen(["afplay",song_path])
    return current_player


user_selection_index = 0
songs = listSongs(SONGS_DIR, user_selection_index, current_playing_song)

fd = sys.stdin.fileno()
old_settings = termios.tcgetattr(fd)

try:
    tty.setraw(sys.stdin.fileno())
    while True:
        char = sys.stdin.read(1)
        
        if char in ('\r', '\n'):
            current_playing_song = songs[user_selection_index]
            playSong(current_playing_song)
            songs = listSongs(SONGS_DIR, user_selection_index, current_playing_song)
            continue
            
        if char == '\x03': # Ctrl+C
            sys.exit(0)
            
        if char == '\x1b':
            next_char = sys.stdin.read(1)
            if next_char == '[':
                arrow_char = sys.stdin.read(1)
                if arrow_char == 'A': # Up Key
                    user_selection_index = max(0, user_selection_index - 1)
                elif arrow_char == 'B': # Down Key
                    user_selection_index = min(len(songs) - 1, user_selection_index + 1)
                    
        songs = listSongs(SONGS_DIR, user_selection_index, current_playing_song)
        
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)