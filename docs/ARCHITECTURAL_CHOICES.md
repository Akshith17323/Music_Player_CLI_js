# Architectural Choices and Design Decisions

> **Primary Focus:** The primary production codebase of this project is the **Node.js application (`cli_player.js`)**. All production features—interactive VLC IPC control, ANSI in-place redrawing, monotonic timing, asynchronous metadata extraction, and automatic playlist advancement—are built entirely in JavaScript. The Python script (`cli_player.py`) was an early proof-of-concept whose limitations motivated the JavaScript architecture.

This document provides an in-depth reference for the architectural choices, engineering trade-offs, and system design patterns implemented in the primary JavaScript runtime (`cli_player.js`).

---

## 1. System Overview and Design Philosophy

```
+-------------------------------------------------------------------------+
|                           User Terminal (TTY)                           |
+--------------------+--------------------------------+-------------------+
                     | Raw Keyboard Input             ^ ANSI Escape Codes
                     v (Byte Streams / Keypresses)    | (In-Place Redraw)
+--------------------+--------------------------------+-------------------+
|                        Node.js Runtime Controller                       |
|                                                                         |
|  +--------------------+  +----------------------+  +-----------------+  |
|  | Input Stream &     |  | Monotonic Progress   |  | Library Scanner |  |
|  | Keypress Decoder   |  | Timer (perf_hooks)   |  | & Reconciler    |  |
|  +--------------------+  +----------------------+  +-----------------+  |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |             Process Lifecycle & Playback State Machine            |  |
|  |             (Ownership Tracking, Idempotent Cleanup)              |  |
|  +-----------------------------------+-------------------------------+  |
+--------------------------------------|----------------------------------+
          | Stdin Commands ('pause\n', | Async Child Spawn & Stderr Diags
          | 'seek +5\n') Pipe          v
          v
+------------------------+   +--------------------------------------------+
| VLC Media Player (RC)  |   | macOS afinfo (Metadata Subprocess)         |
| Out-of-Process Backend |   | Asynchronous Duration Lookup (5s Deadline) |
+------------------------+   +--------------------------------------------+
```

### Core Tenets
1. **Zero External Runtime Dependencies:** Built strictly using native Node.js standard libraries (`node:fs`, `node:child_process`, `node:readline`, `node:perf_hooks`). No `npm install`, `node_modules`, or build pipeline required.
2. **Out-of-Process Media Engine:** Audio decoding and digital-to-analog output are delegated to an isolated VLC process rather than linking heavy C/C++ audio libraries into the Node event loop.
3. **Defensive Systems Programming:** Fail-fast startup validation, non-blocking I/O, monotonic time measurement, ownership token verification on asynchronous events, and signal-safe cleanup ensure the terminal and host processes are never left in an unrecoverable or corrupted state.

---

## 2. Key Architectural Choices

### Choice 1: Audio Backend — Out-of-Process VLC (RC Mode) vs Native Bindings vs `afplay`

| Dimension | Out-of-Process VLC (`--intf rc`) | `afplay` + OS Signals | In-Process Native C Bindings (FFI/N-API) |
| :--- | :--- | :--- | :--- |
| **Interactive Control** | Full duplex (stdin commands: `pause\n`, `seek`) | None (only crude `SIGSTOP`/`SIGCONT`) | Millisecond-accurate programmatic callbacks |
| **Crash Blast Radius** | Process-isolated (VLC crash doesn't crash UI) | Process-isolated | Fatal segfault brings down entire Node runtime |
| **Dependencies** | Requires external VLC binary | macOS native `/usr/bin/afplay` | Complex C toolchains, node-gyp, ABI breakage |
| **Format Support** | Comprehensive (MP3, FLAC, Ogg, Opus, AAC, etc.) | Limited to macOS AudioToolbox formats | Dependent on linked libraries |

#### Rationale
- **Why not `afplay`?** The Python prototype initially tested macOS `afplay`. However, `afplay` provides zero interactive IPC. Pausing via `SIGSTOP`/`SIGCONT` suspends the entire OS process, stalling CoreAudio buffers, causing audio pops, and preventing any communication.
- **Why VLC Remote Control (`--intf rc`)?** Spawning VLC with `--intf rc` exposes a lightweight text command stream over `stdin`. Sending `pause\n` or `seek +5\n` toggles playback and relative position natively without freezing the process.
- **Flag Configuration:** To enforce Node's playlist sovereignty, VLC is launched with:
  - `--play-and-exit`: VLC terminates as soon as a track completes, handing playlist sequencing back to Node.
  - `--no-loop`, `--no-repeat`, `--no-random`: Prevents VLC from looping internally.
  - `--no-play-and-stop`, `--no-play-and-pause`, `--no-start-paused`: Overrides any persistent user GUI preferences in VLC.
  - `--no-quiet --verbose 0 --no-color`: Emits clean error diagnostics on `stderr` while keeping I/O minimal.

---

### Choice 2: Duration & Metadata Extraction — Decoupled Subprocess with Deadline

#### The Problem
VLC does not synchronously return duration upon launch without querying its RC interface, which can block or produce parsing ambiguity. Conversely, bundling audio-parsing npm packages would break the zero-dependency rule.

#### The Solution
- Extract duration using macOS's native `afinfo` tool in a separate asynchronous child process (`getSongDuration`).
- **Decoupled Playback & UI Rendering:** Playback starts immediately without waiting for `afinfo`. The UI displays `Looking up duration...` and transitions to numeric progress once the promise resolves.
- **Strict Execution Deadline:** The `spawn` invocation configures a 5000 ms timeout and `SIGKILL`. If `afinfo` hangs on corrupt metadata, it is terminated without disrupting audio playback, safely falling back to `Duration unavailable` (resolving issue **B18**).
- **Duration Precision Preservation:** Floating-point seconds are parsed and retained for smooth progress percentage calculations, while `Math.ceil()` is applied strictly at render time. This prevents integer truncation from adding false seconds (resolving issue **B15**).

---

### Choice 3: Terminal UI Architecture — Direct ANSI Escape Codes vs TUI Frameworks

Rather than adopting heavy TUI abstractions like `blessed` or `ink` (React-based CLI), the project renders directly using ANSI escape sequences over raw stdout.

#### In-Place Redraw Mechanism
Standard `console.log()` appends newlines, causing the screen to scroll indefinitely. To achieve an in-place interactive menu:
1. **Cursor Repositioning:** `\x1B[2;1H` moves the cursor to line 2, column 1 (preserving any header area).
2. **Line Clearing:** `\r\x1B[0K` moves the carriage to column 0 and clears the line to the right before drawing text, preventing "ghosting" artifacts from previously rendered longer track names.
3. **Region Clearing:** `\x1B[0J` clears from the cursor to the end of the screen when redrawing menu boundaries.

```
Terminal Grid:
Row 1: [Screen clear / Top boundary]
Row 2: > Song One.mp3               (\x1B[2;1H\r\x1B[0K)
Row 3:   Song Two.flac              (\r\x1B[0K)
Row 4:   Song Three.wav             (\r\x1B[0K)
...
Row N+2: Playing: Song One.mp3      (\x1B[N+2;1H\r\x1B[0K)
Row N+3: 14 / 210 || 6.67 %         (\r\x1B[0K)
Row N+4: [XXXXX...................] (\r\x1B[0K)
```

---

### Choice 4: Terminal Input Processing — Byte Stream Decoding & Mode Handling

#### Node.js Implementation
- Uses `process.stdin.setRawMode(true)` to receive raw keypress bytes without waiting for Enter.
- Leverages `readline.emitKeypressEvents(process.stdin)` to buffer and parse multi-byte escape sequences (such as arrow keys `\x1b[A` / `\x1b[B` and application mode `\x1bOA` / `\x1bOB`).
- **Emergency Escape Bypass:** The raw input handler explicitly checks `key.sequence.includes('\x03')` (Ctrl+C). This ensures that even if an escape sequence arrives malformed or incomplete, Ctrl+C triggers immediate exit.
- **Transport & Seek Bindings:** Up/Down handles selection, Left/Right performs 5-second relative seeks, Space/`p` toggles pause, and `n`/`b`/`d` handles track skipping.

---

### Choice 5: Concurrency, Ownership Tokens & Race Condition Prevention

In an event-driven CLI player, user interactions are inherently asynchronous: a user might press Next (`n`) three times within 100 ms, or start a new song while an earlier track's metadata or exit handlers are queued.

```
User presses Enter (Song A) --------> Spawn Child Process A (PID 101)
                                      `-- Metadata Request A (PID 102)
User immediately presses Enter (Song B)
  |
  +--> stopPlayback():
         1. Invalidate reference: vlcPlayProcess = undefined
         2. Clear tracking interval
         3. Send SIGKILL to PID 101 and PID 102
  |
  +--> Spawn Child Process B (PID 103)
         `-- vlcPlayProcess = Child B
```

#### Ownership Verification Pattern
To prevent race conditions where a late callback from Child A alters the state of Child B:
1. Every child process spawned is registered in an `ownedChildProcesses` Set.
2. In async handlers (`close`, `error`, `metadata.then`), the handler checks:
   ```javascript
   if (vlcPlayProcess !== currentProcess) return; // Stale callback; discard
   ```
3. `stopPlayback()` sets `vlcPlayProcess = undefined` **before** issuing termination signals. If an old process fires `close` during shutdown, the event is safely recognized as stale and ignored.

#### False-Success Detection in VLC
VLC 3.x can fail to decode an audio file (e.g. missing codec, corrupted stream) and still terminate with exit code `0`. To prevent Node from falsely interpreting this as normal completion and automatically playing the next song in an infinite loop:
- A rolling 4 KB stderr diagnostic tail is buffered.
- Diagnostics are pattern-matched against `/(?:input|stream|demux|decoder|audio output) error:/i` (while filtering non-fatal cache warnings).
- If matched, `playbackFailed` is flagged, advancement is halted, and a visible playback error is presented to the user.

---

### Choice 6: Timing & Progress Estimation — Monotonic Clock vs Wall Clock

#### The Architecture
The player tracks elapsed time using a 100 ms interval loop. Rather than checking wall-clock timestamps (`Date.now()`), it calculates elapsed time using `perf_hooks.performance.now()`.

#### Rationale (Fixing Issue B16)
- **Monotonic Clock Guarantee:** `Date.now()` is subject to system clock adjustments (NTP synchronization, daylight saving shifts, manual changes). If the clock steps backward, `Date.now()` delta becomes negative.
- When progress calculation `(timeElapsed / totalDuration) * 100` received a negative number, `renderBar()` executed `"X".repeat(negativeNumber)`, throwing `RangeError: Invalid count value`.
- Using `performance.now()` guarantees that time deltas are strictly non-negative ($\Delta t \ge 0$). Additionally, math clamping (`Math.max(0, Math.min(100, ...))`) guards all progress inputs.

---

### Choice 7: Dynamic Library Scanning & Selection Reconciliation

#### Scanning Design
- **Allowlist Filtering:** Checks files against known audio extensions (`.mp3`, `.m4a`, `.flac`, `.wav`, `.ogg`, `.opus`, etc.) using case-insensitive extension matching.
- **Stat Verification:** Verifies entries are readable regular files (`fs.statSync().isFile()` and `accessSync(R_OK)`). Symlinks pointing to regular readable files are accepted; directories and broken links are omitted (resolving issue **B12**).
- **Fast Startup:** Avoids decoding media headers during scanning, allowing instantaneous initialization. Corrupted media is handled gracefully at runtime by the player error handlers.

#### Selection Reconciliation
When the song directory changes at runtime (files added or deleted):
1. The active user selection (`cursor`) tracks the file by name rather than array index.
2. If the selected file still exists in the refreshed directory, `cursor` updates to its new index.
3. If the file was deleted, `cursor` is clamped within bounds (`0` to `allSongs.length - 1`).
4. If the actively playing song is deleted from disk mid-playback, it is allowed to finish playing; on completion, adjacent song calculations find its successor based on sorted alphabetical order.

---

### Choice 8: Fail-Safe Process Termination and Terminal Restoration

Terminal raw mode disables standard OS signal processing (such as Ctrl+C generating `SIGINT`). If a CLI crashes or exits without resetting the terminal mode, the user's terminal session is left broken (keystrokes invisible, Enter not producing newlines).

#### Cleanup Architecture
```
Triggers:
- User presses Ctrl+C ('\x03')
- Signals: SIGHUP, SIGINT, SIGQUIT, SIGTERM
- Stdin stream 'end', 'close', 'error'
- Process 'uncaughtExceptionMonitor' / 'exit'
                       |
                       v
         +----------------------------+
         |   cleanupApplication()     |
         |   (Idempotent Flag Guard)  |
         +--------------+-------------+
                        |
        +---------------+---------------+
        |                               |
        v                               v
+-----------------------+   +------------------------+
| stopPlayback()        |   | restoreTerminal()      |
| - Kill VLC instances  |   | - Detach listeners     |
| - Kill afinfo procs   |   | - setRawMode(previous) |
| - Clear intervals     |   | - stdin.pause()        |
+-----------------------+   +------------------------+
```

1. **Idempotence:** Guarded by `applicationCleanedUp` and `shutdownStarted` flags to prevent recursive cleanup on cascading signals.
2. **Terminal Restoration:** Restores the exact prior raw mode state (`setRawMode(previousStdinRawMode)`), detaches keypress listeners, and unrefs/pauses stdin.
3. **Subprocess Reaping:** Iterates over `ownedChildProcesses` and kills any running instances with `SIGKILL`.

---

## 3. Comparison: JavaScript Player vs Python Prototype

| Feature / Architecture | JavaScript (`cli_player.js`) | Python (`cli_player.py`) |
| :--- | :--- | :--- |
| **Audio Engine** | VLC (`--intf rc`) via pipe | `afplay` via `subprocess.Popen` |
| **Transport Controls** | Play, Pause, Resume, Next, Previous, Seek 5s | Play, Restart selected |
| **Duration & Progress** | Async `afinfo` + monotonic progress bar | Not supported |
| **Auto-Advancement** | Built-in with playlist wraparound | Stops after song finishes |
| **Input Polling** | Node libuv event loop (`readline`) | POSIX `select.select()` + `KeyDecoder` |
| **Terminal Handling** | `process.stdin.setRawMode(true)` | `termios.tcsetattr` (raw mode) |
| **Process Ownership** | Token check on closure/error events | Deferred signal masks during `Popen` |

---

## 4. Known Limitations & Trade-Offs

1. **Audio Position Drift (Issue B17):**
   - *Design Trade-off:* Local monotonic elapsed time is estimated rather than querying VLC's position over RC IPC every 100 ms.
   - *Consequence:* Under high CPU load or during audio device latency, elapsed time can slightly lead actual audio output.
2. **Viewport Pagination on Small Terminals (Issue B19):**
   - *Design Trade-off:* Song list assumes terminal height $\ge$ song count + 5 lines.
   - *Consequence:* Large libraries (>50 songs) on small terminal windows can cause vertical scrolling.
3. **Platform Portability:**
   - *Design Trade-off:* Relies on macOS `/usr/bin/afinfo` for duration lookup.
   - *Consequence:* While VLC runs cross-platform, duration lookup requires macOS or an alternative tool like `mediainfo` / `ffprobe` on Linux/Windows.
