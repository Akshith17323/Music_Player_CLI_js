const { accessSync, constants, readdirSync, statSync } = require("fs");
const { delimiter, isAbsolute, join, resolve } = require("path");
const { homedir } = require("os");
const { spawn } = require("child_process");
const { emitKeypressEvents } = require("readline");

const songDir = join(__dirname, 'songs');
let allSongs = null;
let cursor = 0;
let isPaused = true;
let vlcPlayProcess = undefined;

let totalDuration = undefined;
let timeElapsed = undefined;
let trackingInterval = undefined;
let playingSong = undefined;
let executables = undefined;
const ownedChildProcesses = new Set();
let stdinRawModeConfigured = false;
let previousStdinRawMode = false;
let shutdownStarted = false;
let applicationCleanedUp = false;
let shutdownHandlersInstalled = false;

function findExecutable(command) {
    const expanded = command.startsWith('~/') ? join(homedir(), command.slice(2)) : command;
    const candidates = isAbsolute(expanded) || expanded.includes('/')
        ? [resolve(expanded)]
        : (process.env.PATH || '').split(delimiter).map(directory => resolve(directory, expanded));

    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            if (statSync(candidate).isFile()) return candidate;
        } catch {
            // Try the next candidate when a file is missing or inaccessible.
        }
    }
    return undefined;
}

function resolveDependency(name, variable, defaults) {
    const configured = process.env[variable];
    for (const command of configured ? [configured] : defaults) {
        const executable = findExecutable(command);
        if (executable) return executable;
    }
    const location = configured ? ` (${configured})` : '';
    throw new Error(`${name}${location} was not found or is not executable. Set ${variable} to its executable path.`);
}

function configureExecutables() {
    if (process.platform !== 'darwin') {
        throw new Error(`This player requires macOS and afinfo; detected ${process.platform}.`);
    }
    return {
        vlc: resolveDependency('VLC', 'VLC_PATH', [
            'vlc',
            '/Applications/VLC.app/Contents/MacOS/VLC',
            join(homedir(), 'Applications/VLC.app/Contents/MacOS/VLC')
        ]),
        afinfo: resolveDependency('afinfo', 'AFINFO_PATH', ['afinfo', '/usr/bin/afinfo'])
    };
}

function executableFailure(name, variable, error) {
    const hint = ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(error.code)
        ? ` Check ${variable} and executable permissions.`
        : '';
    return new Error(`${name}: ${error.message}${hint}`);
}

function ownChildProcess(childProcess) {
    ownedChildProcesses.add(childProcess);
    childProcess.once('close', () => ownedChildProcesses.delete(childProcess));
    return childProcess;
}

function stopOwnedChildProcesses() {
    for (const childProcess of ownedChildProcesses) {
        if (childProcess.exitCode != null || childProcess.signalCode != null) continue;
        try {
            childProcess.kill('SIGKILL');
        } catch {
            // The process may have exited between the state check and kill.
        }
    }
}

async function getSongDuration(songFilePath) {
    return new Promise((resolve, reject) => {
        const fail = error => reject(executableFailure('afinfo', 'AFINFO_PATH', error));
        let afinfoCP;
        try {
            afinfoCP = ownChildProcess(spawn(executables.afinfo, [songFilePath], { stdio: ['ignore', 'pipe', 'ignore'] }));
        } catch (error) {
            fail(error);
            return;
        }

        afinfoCP.on('error', fail);
        afinfoCP.stdout.on('error', fail);

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
    if (timeElapsed !== undefined && totalDuration !== undefined && allSongs !== null && playingSong !== undefined) {
        const percentagePlayed = Math.min(100, ((timeElapsed / totalDuration) * 100).toFixed(2));
        const bar = renderBar(percentagePlayed);
        process.stdout.write(`\x1B[${allSongs.length + 2};1H\r\x1B[0KPlaying: ${playingSong}`);
        process.stdout.write(`\n\x1B[0K${Math.ceil(timeElapsed)} / ${totalDuration} || ${percentagePlayed} %`);
        process.stdout.write(`\n\x1B[0K${bar}\n`);
    }
}

function renderBar(percentagePlayed) {
    const playedCharC = Math.round(50 * (percentagePlayed) / 100);
    const progressBar = "X".repeat(playedCharC) + ".".repeat(50 - playedCharC);
    return progressBar;
}

function refreshSongs() {
    const selectedSong = allSongs?.[cursor];
    const songs = readdirSync(songDir).filter(file => !file.startsWith('.')).sort();
    const changed = allSongs === null || songs.length !== allSongs.length || songs.some((song, index) => song !== allSongs[index]);
    allSongs = songs;

    const selectedIndex = allSongs.indexOf(selectedSong);
    cursor = selectedIndex !== -1 ? selectedIndex : Math.max(0, Math.min(cursor, allSongs.length - 1));
    return changed;
}

function listSongs() {
    process.stdout.write("\x1B[2;1H\x1B[0J");

    if (allSongs.length === 0) {
        process.stdout.write("\r\x1B[0KNo songs found in the songs folder.\n");
    } else {
        const menuText = allSongs.map((songName, index) => {
            return ("\r\x1B[0K" + (index === cursor ? '> ' : '  ') + songName);
        }).join("\n");

        process.stdout.write(menuText + "\n");
    }

    updateProgress();
}

function stopPlayback() {
    vlcPlayProcess = undefined;
    if (trackingInterval !== undefined) clearInterval(trackingInterval);
    trackingInterval = undefined;
    isPaused = true;
    playingSong = undefined;
    timeElapsed = undefined;
    totalDuration = undefined;

    stopOwnedChildProcesses();
}

function showPlaybackError(message) {
    process.stdout.write(`\x1B[${allSongs.length + 2};1H\r\x1B[0JPlayback error: ${message}\n`);
}

function playSong(targetCursor) {
    const songName = allSongs?.[targetCursor];
    refreshSongs();
    const targetIndex = allSongs.indexOf(songName);
    if (!Number.isInteger(targetCursor) || targetIndex === -1) {
        listSongs();
        return;
    }

    stopPlayback();

    isPaused = false;
    cursor = targetIndex;
    playingSong = songName;
    listSongs();
    process.stdout.write(`\x1B[${allSongs.length + 2};1H\r\x1B[0J`);

    const songFinalPath = join(songDir, songName);

    // Node owns the playlist. Each VLC instance plays one track, then exits.
    let currentProcess;
    try {
        currentProcess = ownChildProcess(spawn(executables.vlc, [
            "--intf", "rc", "--play-and-exit",
            "--no-loop", "--no-repeat", "--no-random",
            "--no-play-and-stop", "--no-play-and-pause", "--no-start-paused",
            "--no-quiet", "--verbose", "0", "--no-color",
            songFinalPath
        ], { stdio: ['pipe', 'ignore', 'pipe'] }));
    } catch (error) {
        stopPlayback();
        showPlaybackError(executableFailure('VLC', 'VLC_PATH', error).message);
        return;
    }
    vlcPlayProcess = currentProcess;
    startElapsedTracking();

    const handlePlayerError = (error) => {
        if (vlcPlayProcess !== currentProcess) return;
        stopPlayback();
        showPlaybackError(error.message);
    };
    currentProcess.on('error', error => handlePlayerError(executableFailure('VLC', 'VLC_PATH', error)));
    currentProcess.stdin.on('error', handlePlayerError);
    currentProcess.stderr.on('error', handlePlayerError);

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
    }).catch(handlePlayerError);

    currentProcess.once('close', (code, signal) => {
        if (vlcPlayProcess !== currentProcess) return;

        vlcPlayProcess = undefined;
        stopPlayback();
        refreshSongs();
        listSongs();

        if (code === 0 && !signal && !playbackFailed) {
            playSong(getAdjacentSongIndex(songName, 1));
        } else {
            const reason = playbackFailed
                ? `VLC could not play ${songName}`
                : `VLC stopped ${signal ? `by ${signal}` : `with exit code ${code}`}`;
            showPlaybackError(reason);
        }
    });
}

function getAdjacentSongIndex(songName, offset) {
    if (allSongs.length === 0) return -1;
    const songIndex = allSongs.indexOf(songName);
    if (songIndex !== -1) return (songIndex + offset + allSongs.length) % allSongs.length;

    // A removed track keeps its place in the sorted playback order.
    const followingIndex = allSongs.findIndex(song => song > songName);
    const nextIndex = followingIndex === -1 ? 0 : followingIndex;
    return offset > 0 ? nextIndex : (nextIndex - 1 + allSongs.length) % allSongs.length;
}

function skipSong(offset) {
    if (allSongs.length === 0) return;
    const targetIndex = playingSong === undefined
        ? (cursor + offset + allSongs.length) % allSongs.length
        : getAdjacentSongIndex(playingSong, offset);
    playSong(targetIndex);
}

function restoreTerminal() {
    process.stdin.removeListener('keypress', handleInput);
    process.stdin.removeListener('end', handleInputEnd);
    process.stdin.removeListener('close', handleInputEnd);
    process.stdin.removeListener('error', handleInputError);

    if (stdinRawModeConfigured && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        try {
            process.stdin.setRawMode(previousStdinRawMode);
        } catch {
            // Shutdown must continue even if the terminal has already closed.
        }
    }
    stdinRawModeConfigured = false;
    process.stdin.pause();
}

function cleanupApplication() {
    if (applicationCleanedUp) return;
    applicationCleanedUp = true;
    try {
        stopPlayback();
    } finally {
        restoreTerminal();
    }
}

function shutdown(exitCode) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    cleanupApplication();
    process.exit(exitCode);
}

function handleInputEnd() {
    shutdown(0);
}

function handleInputError(error) {
    try {
        process.stderr.write(`Input error: ${error.message}\n`);
    } finally {
        shutdown(1);
    }
}

function installShutdownHandlers() {
    if (shutdownHandlersInstalled) return;
    shutdownHandlersInstalled = true;

    const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };
    for (const [signal, exitCode] of Object.entries(signalExitCodes)) {
        process.once(signal, () => shutdown(exitCode));
    }

    // Preserve Node's normal fatal-error reporting while releasing resources first.
    process.once('uncaughtExceptionMonitor', cleanupApplication);
    process.once('exit', cleanupApplication);
}

function handleInput(_character, key) {
    // Ctrl+C also interrupts incomplete or unsupported escape sequences.
    if (key.sequence.includes('\x03')) {
        shutdown(0);
        return;
    }

    if (refreshSongs()) listSongs();

    if (key.name === 'up' || key.name === 'down') {
        if (allSongs.length === 0) return;
        if (key.name === 'up') {
            cursor = ((cursor - 1) % allSongs.length);
            if (cursor < 0) {
                cursor += allSongs.length;
            }
        } else {
            cursor = (cursor + 1) % allSongs.length;
        }
        listSongs();
        return;
    }

    // play next 'n'
    if (key.sequence === 'n') {
        skipSong(1);
        return;
    }

    // play previous 'b' or 'd'
    if (key.sequence === 'b' || key.sequence === 'd') {
        skipSong(-1);
        return;
    }

    // Enter: CR from raw terminals or LF from piped input.
    if (key.sequence === '\r' || key.sequence === '\n') {
        playSong(cursor);
        return;
    }

    // play/pause 'p' or space
    if (key.sequence === 'p' || key.sequence === ' ') {
        if (vlcPlayProcess !== undefined && !vlcPlayProcess.stdin.destroyed) {
            const currentProcess = vlcPlayProcess;
            try {
                currentProcess.stdin.write('pause\n');
                if (vlcPlayProcess === currentProcess) isPaused = !isPaused;
            } catch (error) {
                if (vlcPlayProcess !== currentProcess) return;
                stopPlayback();
                showPlaybackError(`VLC input: ${error.message}`);
            }
        }
    }
}

function main() {
    try {
        executables = configureExecutables();
    } catch (error) {
        process.stderr.write(`Setup error: ${error.message}\n`);
        process.exitCode = 1;
        return;
    }

    installShutdownHandlers();

    process.stdout.write('\x1b[2J');
    refreshSongs();
    listSongs();
    if (process.stdin.isTTY) {
        previousStdinRawMode = Boolean(process.stdin.isRaw);
        process.stdin.setRawMode(true);
        stdinRawModeConfigured = true;
    }
    emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', handleInput);
    process.stdin.once('end', handleInputEnd);
    process.stdin.once('close', handleInputEnd);
    process.stdin.once('error', handleInputError);
}

main();
