const { spawn } = require('child_process')
const path = require('path')
const { readdirSync } = require('fs')

let songs = []
let userSelectionIndex = 0
const SONGS_DIR = "./songs"

function listSongs(songDirectoryPath) {
    console.clear()
    songs = readdirSync(songDirectoryPath).filter((file) => file.endsWith(".mp3"))
    songs.forEach((song, ind) => {
        if (ind === userSelectionIndex) {
            console.log(`> ${song}`)
        } else {
            console.log(`  ${song}`)
        }
    })
}


function playSong(song_name) {
    const song_path = path.join(SONGS_DIR, song_name)
    const player = spawn("afplay", [song_path])
    console.log(`\nPlaying: ${song_name}`)
    return player
}


listSongs(SONGS_DIR);

// Take User Song Selection
process.stdin.setRawMode(true)
process.stdin.on('data', (rawUserInput) => {
    if (rawUserInput[0] === 0x0d) {
        console.log(`\nUser selected: ${songs[userSelectionIndex]}`)
        playSong(songs[userSelectionIndex])
        return
    }
    if (rawUserInput[0] === 0x03) {
        process.exit(0)
    } else {
        if (rawUserInput[0] === 0x1b) {
            if (rawUserInput[1] === 0x5b) {
                if (rawUserInput[2] === 0x41) { // Up Key
                    userSelectionIndex = Math.max(0, userSelectionIndex - 1)
                }
                if (rawUserInput[2] === 0x42) { // Down Key
                    userSelectionIndex = Math.min(songs.length - 1, userSelectionIndex + 1)
                }
            }
        }
    }
    listSongs(SONGS_DIR)
})
