const { readdirSync } = require("fs");
const { join } = require("path");
const { spawn } = require("child_process");
process.stdin.setRawMode(true);

let user_input = 0;
let songs = undefined;
let player = undefined;
let song_is_playing = false;

function listSongs(directoryPath) {
  songs = readdirSync(directoryPath);
  process.stdout.write("\x1B[2J");
  process.stdout.write("\x1B[2;1H");

  let menuText = songs
    .map((ele, ind) => {
      if (user_input == ind) {
        return `> ${ele}`;
      } else {
        return `  ${ele}`;
      }
    })
    .join("\n");
  process.stdout.write(menuText);
}

function playSongs(directoryPath) {
  // Using VLC instead of afplay
  player = spawn("/Applications/VLC.app/Contents/MacOS/VLC", ["--intf", "rc", directoryPath]);
  // console.log(player)
}

listSongs(join("songs"));

process.stdin.on("data", (data) => {
  console.log(data);
  if (data[0] == 0x0d) {
    if (!song_is_playing) {
      playSongs(join("songs", songs[user_input]));
      song_is_playing = true;
    } else {
      player.kill("SIGKILL");
      process.exit(0);
      song_is_playing = false;
    }
    return;
  }
  if (data[0] == 3) {
    process.exit(0);
    return;
  }
  if (data[0] == 0x20) {
    if (song_is_playing) {
      player.kill("SIGSTOP");
      song_is_playing = false;
    } else {
      player.kill("SIGCONT");
      song_is_playing = true;
    }
  }
  if (data[0] == 0x6e) { // Fixed "0x6E" string to number 0x6e for 'n' key
    if (player) player.kill("SIGTERM");
    user_input = Math.min(songs.length - 1, user_input + 1);
    listSongs(join("songs"));
    playSongs(join("songs", songs[user_input]));
    song_is_playing = true;
  }
  if (data[0] == 0x64) { // Fixed "0x64" string to number 0x64 for 'd' key
    if (player) player.kill("SIGTERM");
    user_input = Math.max(0, user_input - 1);
    listSongs(join("songs"));
    playSongs(join("songs", songs[user_input]));
    song_is_playing = true;
  }
  if (data[0] == 0x1b && data[1] == 0x5b) {
    if (data[2] == 0x41) {
      user_input = Math.max(0, user_input - 1);
      listSongs(join("songs"));
    }
    if (data[2] == 0x42) {
      user_input = Math.min(songs.length - 1, user_input + 1);
      listSongs(join("songs"));
    }
  }
});



