import subprocess
import os

SONGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs")


def listSongs(directory_path):
    scanner = subprocess.run(["ls", directory_path],capture_output=True,text=True)
    songs = scanner.stdout.strip().split("\n")
    for ind, song in enumerate(songs):
        print(f"{ind}: {song}")
    return songs


def playSong(song_name):
    song_path = os.path.join(SONGS_DIR,song_name)
    player = subprocess.run(["afplay",song_path])
    return player


songs = listSongs(SONGS_DIR)

try:
    user_choice = int(input().strip())
    print(f"User chose {user_choice}")
    print(songs)
    print(f"{SONGS_DIR}/{songs[user_choice]}")
    playSong(songs[user_choice])
except (ValueError, IndexError) as e:
    print(f"Invalid choice: {e}")