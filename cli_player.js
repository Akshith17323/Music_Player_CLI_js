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
    return new Promise((resolve) => {
        const afinfoCP = spawn("afinfo", [songFilePath], { stdio: ['ignore', 'pipe', 'ignore'] });

        afinfoCP.on('error', () => resolve(0));

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

    if (allSongs.length === 0) {
        process.stdout.write("\r\x1B[0KNo songs found in the songs folder.\n");
        return;
    }

    const menuText = allSongs.map((songName, index) => {
        return ("\r\x1B[0K" + (index === cursor ? '> ' : '  ') + songName);
    }).join("\n");

    process.stdout.write(menuText + "\n");
    updateProgress();
}

function stopPlayback() {
    const previousProcess = vlcPlayProcess;
    vlcPlayProcess = undefined;
    if (trackingInterval !== undefined) clearInterval(trackingInterval);
    trackingInterval = undefined;
    isPaused = true;
    playingIndex = -1;
    timeElapsed = undefined;
    totalDuration = undefined;

    if (previousProcess) previousProcess.kill("SIGKILL");
}

function showPlaybackError(message) {
    process.stdout.write(`\x1B[${allSongs.length + 2};1H\r\x1B[0JPlayback error: ${message}\n`);
}

function playSong(targetCursor) {
    if (!Number.isInteger(targetCursor) || targetCursor < 0 || targetCursor >= allSongs.length) return;

    stopPlayback();

    isPaused = false;
    cursor = targetCursor;
    playingIndex = targetCursor;
    listSongs(songDir);
    process.stdout.write(`\x1B[${allSongs.length + 2};1H\r\x1B[0J`);

    const songFinalPath = join(songDir, allSongs[targetCursor]);

    // Node owns the playlist. Each VLC instance plays one track, then exits.
    const currentProcess = spawn("/Applications/VLC.app/Contents/MacOS/VLC", [
        "--intf", "rc", "--play-and-exit",
        "--no-loop", "--no-repeat", "--no-random",
        "--no-play-and-stop", "--no-play-and-pause", "--no-start-paused",
        "--no-quiet", "--verbose", "0", "--no-color",
        songFinalPath
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    vlcPlayProcess = currentProcess;
    startElapsedTracking();

    const handlePlayerError = (error) => {
        if (vlcPlayProcess !== currentProcess) return;
        stopPlayback();
        showPlaybackError(error.message);
    };
    currentProcess.on('error', handlePlayerError);
    currentProcess.stdin.on('error', handlePlayerError);

    let diagnosticTail = "";
    let playbackFailed = false;
    currentProcess.stderr.on('data', (data) => {
        const diagnostics = diagnosticTail + data.toString();
        // VLC can exit with code 0 even when opening/decoding the input failed.
        if (/\b(?:input|stream|demux|decoder|audio output) error:/i.test(diagnostics)) {
            playbackFailed = true;
        }
        diagnosticTail = diagnostics.slice(-4096);
    });

    getSongDuration(songFinalPath).then(duration => {
        if (vlcPlayProcess === currentProcess) {
            totalDuration = duration;
        }
    });

    currentProcess.once('close', (code, signal) => {
        if (vlcPlayProcess !== currentProcess) return;

        vlcPlayProcess = undefined;
        stopPlayback();

        if (code === 0 && !signal && !playbackFailed) {
            playSong((targetCursor + 1) % allSongs.length);
        } else {
            const reason = playbackFailed
                ? `VLC could not play ${allSongs[targetCursor]}`
                : `VLC stopped ${signal ? `by ${signal}` : `with exit code ${code}`}`;
            showPlaybackError(reason);
        }
    });
}

function skipSong(offset) {
    if (allSongs.length === 0) return;
    const baseIndex = playingIndex === -1 ? cursor : playingIndex;
    playSong((baseIndex + offset + allSongs.length) % allSongs.length);
}

process.stdout.write('\x1b[2J');
listSongs(songDir);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (data) => {
    if (data[0] === 0x1b) {
        if (allSongs.length === 0) return;
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
        skipSong(1);
        return;
    }

    // play previous 'b' (98) or 'd' (100)
    if (data[0] === 98 || data[0] === 100) { 
        skipSong(-1);
        return;
    }

    // enter key
    if (data[0] === 0x0d) {
        playSong(cursor);
        return;
    }

    // ctrl+c
    if (data[0] === 0x03) {
        stopPlayback();
        process.exit(); 
    }

    // play/pause 'p' (112) or space (32)
    if (data[0] === 112 || data[0] === 0x20) {
        if (vlcPlayProcess !== undefined && !vlcPlayProcess.stdin.destroyed) {
            isPaused = !isPaused;
            // using rc interface 'pause' command
            vlcPlayProcess.stdin.write('pause\n');
        }
    }
});
