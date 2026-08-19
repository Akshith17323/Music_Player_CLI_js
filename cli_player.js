const {spawn} = require('child_process')
const path =require('path')

const {readdirSync} = require('fs')


const SONGS_DIR = "./songs"

function listSongs(directory_path){
    // Input : Folder Path || Output: Content of Folder || ls
    const scanner = spawn(
        readdirSync(directory_path)
    )
    scanner.stdout.on('data',(data)=>{
        let songs = (data.toString().trim().split("\n"))
        songs.forEach((song,ind)=> {
            console.log(`${ind} : ${song}`)
        });
       
    })
}

function playSong(song_name){
    const song_path = path.join(SONGS_DIR,song_name)
    const  player= spawn("afplay", [song_path])
    return player
}


listSongs(SONGS_DIR);

playSong("OneRepublic - Sunshine.mp3")