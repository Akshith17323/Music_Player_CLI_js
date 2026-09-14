const { readdirSync } = require("fs");
const { join } = require("path");
const { spawn } = require("child_process");

const songDir = join(__dirname, 'songs');
let allSongs = null;
let cursor = 0;
let isPaused = true;
let vlcPlayProcess = undefined;

let totalDuration = undefined;
let timeElapsed = undefined;
let trackingInterval = undefined;
let playingIndex = -1;

async function getSongDuration(songFilePath) {
    return new Promise((resolve, reject) => {
        const afinfoCP = spawn("afinfo", [songFilePath]);

        let output = "";
        afinfoCP.stdout.on('data', (data) => {
            output += data.toString();
        });

        afinfoCP.on('close', (code) => {
            if (code !== 0) {
                resolve(0);
                return;
            }
            if (output.includes("estimated duration: ")) {
                resolve(Number(output.split("estimated duration: ")[1].split(".")[0]) + 1);
            } else {
                resolve(0);
            }
        });
    });
}

function startElapsedTracking() {
    timeElapsed = 0;
    let lastTickTime = Date.now();
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => {
        const now = Date.now();
        const delta = (now - lastTickTime) / 1000;
        lastTickTime = now;
        
        if (vlcPlayProcess !== undefined && !isPaused) {
            timeElapsed += delta;
        }
        updateProgress();
    }, 100);
}

function updateProgress() {
    if (timeElapsed !== undefined && totalDuration !== undefined && allSongs !== null && playingIndex !== -1) {
        const percentagePlayed = Math.min(100, ((timeElapsed / totalDuration) * 100).toFixed(2));
        const bar = renderBar(percentagePlayed);
        process.stdout.write(`\x1B[${allSongs.length + 2};1H\r\x1B[0KPlaying: ${allSongs[playingIndex]}`);
        process.stdout.write(`\n\x1B[0K${Math.ceil(timeElapsed)} / ${totalDuration} || ${percentagePlayed} %`);
        process.stdout.write(`\n\x1B[0K${bar}\n`);
    }
}

function renderBar(percentagePlayed) {
    const playedCharC = Math.round(50 * (percentagePlayed) / 100);
    const progressBar = "X".repeat(playedCharC) + ".".repeat(50 - playedCharC);
    return progressBar;
}

function listSongs(songDirPath) {
    if (!allSongs) {
        allSongs = readdirSync(songDirPath).filter(file => !file.startsWith('.'));
    }

    process.stdout.write("\x1B[2;1H");

    const menuText = allSongs.map((songName, index) => {
        return ("\r\x1B[0K" + (index === cursor ? '> ' : '  ') + songName);
    }).join("\n");

    process.stdout.write(menuText + "\n");
    updateProgress();
}

function playSong(targetCursor) {
    if (vlcPlayProcess !== undefined) {
        vlcPlayProcess.kill("SIGKILL");
        vlcPlayProcess = undefined;
    }

    isPaused = false;
    totalDuration = undefined;
    playingIndex = targetCursor;
    
    const songFinalPath = join(songDir, allSongs[targetCursor]);
    
    startElapsedTracking();
    vlcPlayProcess = spawn("/Applications/VLC.app/Contents/MacOS/VLC", ["--intf", "rc", songFinalPath]);
    
    const currentProcess = vlcPlayProcess;
    
    getSongDuration(songFinalPath).then(duration => {
        if (vlcPlayProcess === currentProcess) {
            totalDuration = duration;
        }
    });
    
    vlcPlayProcess.on('close', (code) => {
        // null code means it was killed via signal (e.g. SIGKILL). 0 means it finished playing.
        if (code === 0) {
            playingIndex = (playingIndex + 1) % allSongs.length;
            listSongs(songDir);
            playSong(playingIndex);
        }
    });
}

process.stdout.write('\x1b[2J');
listSongs(songDir);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
    if (data[0] === 0x1b) {
        if (data[1] === 0x5b) {
            if (data[2] === 0x41) {
                // up arrow key
                cursor = ((cursor - 1) % allSongs.length); 
                if (cursor < 0) {
                    cursor += allSongs.length;
                }
            } else if (data[2] === 0x42) {
                // down arrow key
                cursor = (cursor + 1) % allSongs.length; 
            }
        }
        listSongs(songDir);
        return;
    }

    // play next 'n' (110)
    if (data[0] === 110) { 
        cursor = (cursor + 1) % allSongs.length;
        listSongs(songDir);
        playSong(cursor);
        return;
    }

    // play previous 'b' (98) or 'd' (100)
    if (data[0] === 98 || data[0] === 100) { 
        cursor = ((cursor - 1) % allSongs.length); 
        if (cursor < 0) {
            cursor += allSongs.length;
        } 
        listSongs(songDir);
        playSong(cursor);
        return;
    }

    // enter key
    if (data[0] === 0x0d) {
        playSong(cursor);
        return;
    }

    // ctrl+c
    if (data[0] === 0x03) {
        if (vlcPlayProcess) vlcPlayProcess.kill("SIGKILL");
        process.exit(); 
    }

    // play/pause 'p' (112) or space (32)
    if (data[0] === 112 || data[0] === 0x20) {
        isPaused = !isPaused;
        if (vlcPlayProcess !== undefined) {
            // using rc interface 'pause' command
            vlcPlayProcess.stdin.write('pause\n');
        }
    }
});
