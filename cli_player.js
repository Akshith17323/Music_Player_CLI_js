const { readdirSync } = require("fs");
const { join } = require("path");
const { spawn } = require("child_process");
process.stdin.setRawMode(true);

let user_input = 0;
let songs = undefined;
let player = undefined;
let song_is_playing = false;
let totalDuration = undefined;
let timeElapsed = undefined;
let trackingInterval = undefined;

async function getSongDuration(songFilePath) {
  return new Promise((resolve, reject) => {
    const afinfoCP = spawn("afinfo", [songFilePath]);
    afinfoCP.stdout.on("data", (data) => {
      resolve(Number(data.toString().split("estimated duration: ")[1].split(".")[0]) + 1);
    });
  });
}

function startElapsedTracking() {
  timeElapsed = 0;
  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(() => {
    if (player !== undefined && song_is_playing) {
      timeElapsed += 0.1;
    }
    listSongs(join("songs"));
  }, 100);
}

function renderBar(percentagePlayed) {
  const playedCharC = Math.round((50 * percentagePlayed) / 100);
  const progressBar = "X".repeat(playedCharC) + ".".repeat(50 - playedCharC);
  return progressBar;
}

function listSongs(directoryPath) {
  songs = readdirSync(directoryPath);
  process.stdout.write("\x1B[2;1H");

  let menuText = songs
    .map((ele, ind) => {
      if (user_input == ind) {
        return `\r\x1B[0K> ${ele}`;
      } else {
        return `\r\x1B[0K  ${ele}`;
      }
    })
    .join("\n");
  process.stdout.write(menuText + "\n");

  if (timeElapsed !== undefined && totalDuration !== undefined) {
    const percentagePlayed = Math.min(100, ((timeElapsed / totalDuration) * 100).toFixed(2));
    process.stdout.write(`\r\x1B[0K${Math.ceil(timeElapsed)} / ${totalDuration} || ${percentagePlayed} %`);
    const bar = renderBar(percentagePlayed);
    process.stdout.write(`\n\x1B[0K${bar}`);
  }
}

async function playSongs(directoryPath) {
  // Using VLC instead of afplay
  totalDuration = await getSongDuration(directoryPath);
  startElapsedTracking();
  player = spawn("/Applications/VLC.app/Contents/MacOS/VLC", ["--intf", "rc", directoryPath]);
  // console.log(player)
}

process.stdout.write('\x1b[2J');
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



