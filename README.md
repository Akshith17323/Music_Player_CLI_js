# CLI Music Player Refinement

## Concepts — Terminal Interfaces & Process Management

### What I Learned
I learned how to take full control of the terminal using Node.js! By enabling `process.stdin.setRawMode(true)`, I could catch single keypresses (like arrows or spacebar) instantly without waiting for the user to hit Enter. I also got to play around with ANSI escape sequences to move the cursor around and clear lines, which made it possible to build an actual UI that redraws in place instead of just printing line after line. On top of that, I learned how to manage background processes using `child_process.spawn` so I could run VLC and `afinfo` behind the scenes to handle the actual music playing and fetch track durations.

### Important Concepts
- `process.stdin.setRawMode(true)`: Grabbing raw keypresses right away without needing Enter.
- ANSI Escape Codes: Cool string commands (like `\x1B[2J` or `\x1B[0K`) that tell the terminal to clear the screen or clear a line.
- `child_process.spawn`: Spinning up external tools asynchronously (like running `vlc` for audio and `afinfo` for duration).
- Process events & Signals: Managing the background VLC process, sending it signals like `SIGKILL` or `SIGSTOP`/`SIGCONT`, and handling terminal exits smoothly.

### How It Relates to the Project
These concepts are the core of the whole CLI music player. The raw mode and ANSI codes let me build the interactive menu that stays in one place. Meanwhile, spawning child processes handles the heavy lifting—VLC actually plays the music in the background while my Node script just acts as the remote control and UI.

### Key Takeaway
You can build really cool, fully interactive terminal apps in Node.js just by combining raw input, ANSI codes, and managing background processes correctly.

---

## Implementation — Building a CLI Music Player

### Objective
To build an interactive CLI music player that reads songs from a folder and gives you full control over playback right from the terminal.

### What I Implemented
- Up/Down arrow navigation (clamped so it doesn't break if you go too high or low).
- In-place UI rendering so the menu stays put (no spamming new lines).
- 'Enter' key to start playing the selected song (if a song is already playing, Enter kills the player and exits the app).
- Spacebar to pause and resume the music natively.
- Next ('n') and Previous ('d') track controls (which safely kill the previous track before starting the new one).
- A neat progress bar that visually shows the time elapsed based on the actual track duration.
- Process cleanup when changing tracks so multiple VLC instances don't pile up (though Ctrl+C currently leaves VLC running).

### Concepts Used
- `fs.readdirSync` to quickly grab all the songs from the local folder.
- `spawn('vlc')` with the `--intf rc` interface for playback.
- `spawn('afinfo')` to fetch the total duration of the track.
- `setInterval` to keep track of elapsed time and update the progress bar smoothly.

### Project Connection
This wraps up our fully functional CLI music player! It brings together everything from basic file system reads to advanced terminal manipulation and process management into one working app.

### Key Takeaway
State management is super important! Keeping track of things like `song_is_playing`, `totalDuration`, and `timeElapsed`, while managing the `trackingInterval`, is the only way to keep the visual UI perfectly synced with the background audio process.

---

## Questionnaire

1. **The first arrow-navigation version printed the song list again and again. Why did that happen, and how did you make the list redraw in the same place?**
   At first, standard `process.stdout.write()` was just pushing new text to the bottom of the terminal, so every update printed a whole new list. To fix this and make it redraw in place, I used ANSI escape sequences. Specifically, `\x1B[2;1H` to move the cursor back to the top of the menu, and `\r\x1B[0K` before printing each line to completely clear the old text on that line before drawing the new one.

2. **Why do we need both cursor movement and line clearing while redrawing the terminal UI? What problem can happen if you only move the cursor?**
   If you just move the cursor back up and write over the old text, you get this weird "ghosting" effect. For example, if the previous song name was really long and the new one is short, the leftover letters from the long name will still be visible at the end of the line. Clearing the line first makes sure we have a blank slate before drawing the new frame.

3. **What does the selected-song variable represent? How do you make sure the user cannot move above the first song or below the last song?**
   I used a variable called `user_input` to keep track of the index of the currently selected song in our `songs` array. To stop it from going out of bounds, I clamped the math. For moving up, I used `Math.max(0, user_input - 1)` so it never drops below 0. For moving down, I used `Math.min(songs.length - 1, user_input + 1)` so it never goes past the last index.

4. **Why was afplay + SIGSTOP/SIGCONT not a reliable solution for a real pause/resume feature? What changed in the final approach?**
   `afplay` is pretty basic and doesn't give us a clean way to pause or check exactly where the song is at. Sending `SIGSTOP` just brutally freezes the whole process at the OS level, which makes keeping track of time in our Node app a nightmare. The final approach was to switch to VLC using its Remote Control interface (`--intf rc`), which is built for this kind of stuff and can theoretically take actual commands (though for now, I'm still using SIGSTOP/SIGCONT for simplicity with VLC!).

5. **How would you prove that the pause/resume implementation is correct? Describe a small test you would perform.**
   I'd start playing a 10-second song and wait exactly 3 seconds, then hit spacebar to pause. I'd wait 5 seconds in real-time, then hit spacebar again to resume. If it's correct, the audio will pick up exactly where it left off at 3 seconds, and the progress bar won't have moved at all during those 5 seconds it was paused. It should finish playing exactly 7 seconds after I resumed it.

6. **How is the progress percentage calculated? What should happen to the progress value while the song is paused?**
   It's a simple math calculation: `(timeElapsed / totalDuration) * 100`. I get `totalDuration` once at the start using `afinfo`. I update `timeElapsed` by adding `0.1` every 100ms inside a `setInterval`, but only if `song_is_playing` is true. Because of that, when the song is paused, `timeElapsed` stops incrementing, so the progress bar automatically freezes in place.

7. **When the user starts a new song while another song is already playing, what needs to be stopped or cleaned up? What could happen if you do not do this?**
   Before starting the new song, I have to kill the existing VLC process using `player.kill("SIGTERM")` or `SIGKILL`, and also clear the old `trackingInterval`. If I forget to do this, the old VLC process keeps running in the background playing the old song, the new VLC process starts playing the new song on top of it, and multiple intervals fight to redraw the progress bar, making the terminal flicker like crazy.

8. **Describe one bug or unexpected behaviour you faced while refining this application. What did you initially think was wrong, how did you investigate it, and what was the actual fix?**
   When I implemented the progress bar, I noticed multiple intervals were running at the same time and making the timer count way too fast. I initially thought the interval delay was too small, but after looking at how I was calling `startElapsedTracking()`, I realized I wasn't clearing the old interval when a new song was played. The fix was adding a simple `if (trackingInterval) clearInterval(trackingInterval);` right before starting the new one.

9. **If you had to add "jump forward 10 seconds" next, which part of the current application would change and what existing playback information would you reuse?**
   I would capture a new keypress (like the right arrow). Since we're using VLC's `rc` interface, I'd send a seek command like `seek +10\n` directly to `player.stdin`. Then, I'd just need to manually add `10` to my `timeElapsed` variable so that the JS progress bar visually jumps forward and stays perfectly in sync with the audio.

---

## Architecture Documentation

### Flow Overview
The application handles asynchronous terminal input, updates internal JS state, orchestrates VLC playback, tracks time, and continuously renders a unified UI frame to standard output.

```mermaid
flowchart TD
    A[User Input via process.stdin] --> B{Key Press}
    
    B -->|Up/Down| C[Update user_input index state]
    B -->|Enter| D{Is playing?}
    B -->|Spacebar| E[Toggle song_is_playing state]
    B -->|Ctrl+C| F2[Force Exit]
    B -->|n/d| C2[Next/Prev Track]

    C --> G[List Songs / Redraw UI]
    C2 --> H[Kill old VLC process & Interval]
    
    D -->|No| H
    D -->|Yes| F[Kill player & Exit]
    
    H --> I[Fetch totalDuration with afinfo]
    I --> J[Spawn VLC process with RC interface]
    J --> K[Start trackingInterval & reset timeElapsed]
    
    E --> L[Send SIGSTOP/SIGCONT to VLC]
    L --> M[Freeze/Unfreeze timeElapsed logic]
    M --> G

    K -. Every 100ms .-> N[Update timeElapsed]
    N --> G
    
    G --> P[Draw song list & progress bar]
```