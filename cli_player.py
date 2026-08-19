# pyrefly: ignore [missing-import]
import subprocess
import os


SONGS_DIR = "./songs"


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


listSongs(SONGS_DIR)

playSong("Chris Brown, Tyga - Girl You Loud.mp3")