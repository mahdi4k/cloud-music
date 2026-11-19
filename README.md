SET UP (one time)
1. npm install
2. npx wrangler login
3. npx wrangler kv namespace create SONGS
   -> Say "yes" when Wrangler asks to add it to your config, and use the binding name SONGS.
   -> For "connect to the remote resource for local dev?" answer N.
   -> Open wrangler.jsonc: there must be only ONE entry with "binding": "SONGS" and a real id.
4. npm run deploy
5. npx wrangler secret put ADMIN_PASSWORD
   -> Type a password you will remember. This is the password for adding/deleting songs.

WHERE YOUR SONGS LIVE (important)
- All songs are stored ON THE WEBSITE (Cloudflare KV), not inside the app files.
- "npm run deploy" only updates the app itself. It NEVER adds, changes or removes songs,
  even when the public/songs folder is empty. Deploy as often as you like.

ADD MANY SONGS AT ONCE (from your computer)
- Put MP3 files into public/songs. Subfolder name = group. Example:
    public/songs/Rock/song.mp3  ->  shown in the group "Rock"
    public/songs/song.mp3       ->  shown in the group "Other"
- Run "npm run deploy" once. The files are uploaded to the website automatically
  (this can take a while for many songs).
- The folder is only an "add these songs" queue: after importing you can empty it,
  the songs stay on the website. Files already imported are skipped on the next deploy.
- Want a changed file with the same name on the website again? Delete the song on the
  website first, then deploy.
- Limit: each file up to 25 MiB.

RESTORE YOUR MUSIC / MOVE IT TO ANOTHER COMPUTER
1. Copy your MP3 files into public/songs (subfolder = group name).
2. npm run deploy  ->  they are uploaded to the website.
3. Done. You can empty public/songs now; the songs stay on the website.

ADD AND DELETE SONGS ON THE WEBSITE (needs internet)
- Open your site address (printed by SET UP step 4).
- Click "Manage" in the left sidebar, type your password, click "Unlock".
- Type a group name (like a folder, for example Rock) and click "Add songs". You can pick many MP3 files at once.
- Click the trash icon next to a song to delete it. This is the ONLY way a song is ever removed.
- You can add songs from any PC, in any browser.

MOVE SONGS TO ANOTHER GROUP (needs internet)
- Click "Manage" and unlock.
- Click the folder icon next to a song, then pick or type a group name and click "Move".
- Or, on a computer, drag a song and drop it on a group in the left sidebar.

GROUP IMAGES (needs internet)
- Click "Manage" and unlock.
- Click the image icon in a group header and pick an SVG, PNG, JPG, WebP or GIF (up to 2 MiB).
- The image is shown on the group header, on every song of that group, and while playing.
- Click the trash icon in the group header to remove the image.
- Group images work offline too after the page has loaded them once.

RENAME A GROUP (needs internet)
- Click "Manage" and unlock.
- Click the pencil icon in a group header, type the new name, click "Rename".
- All songs and the group image move to the new name. Nothing is re-uploaded.

LIKE SONGS (works offline, kept per device)
- Tap the heart next to a song (or in the player, or press F).
- The "Liked" chip at the top shows only your liked songs.

MORE PLAYER THINGS
- "Recent" chip at the top: your songs ordered by what you played last.
- Speed button (shows 1x): tap to cycle 0.75x / 1x / 1.25x / 1.5x / 2x.
- Moon button: sleep timer. Stops the music after 15/30/60 minutes, or after the current song.
- Close the site and come back later: it remembers the song and the position, press play to continue.

LISTEN WITHOUT INTERNET (on each device you want to use)
1. Open the site once with internet.
2. Tap the download icon next to a song, or "Download all". A check mark means it is saved on this device.
3. Without internet, open the site (or the installed app). Downloaded songs play, and you can move the playhead.
   The "Downloaded" button at the top shows only the saved songs.
- Tap the check mark again to remove a song from this device.
- Each device keeps its own downloads. Use Wi-Fi for big downloads.

INSTALL AS AN APP
- Chrome / Edge on PC or Android: click "Install app" at the top of the page (or the install icon in the address bar).
- iPhone / iPad (Safari): tap Share, then "Add to Home Screen". Installing helps iOS keep your downloads.

AFTER YOU CHANGE THE SITE FILES
- Run npm run deploy. Open the site twice (the first open loads the new version in the background).
- If you change public/index.html a lot, change SHELL = "shell-v1" to "shell-v2" in public/sw.js. Downloaded songs are not deleted.

TEST ON YOUR COMPUTER (optional)
- Create a file named .dev.vars with one line:  ADMIN_PASSWORD=choose-a-password
- npm run dev  ->  http://localhost:8787   (local test songs are kept only on your PC)

LIMITS (free plan)
- Each song: up to 25 MiB.  All songs together on the website: 1 GB.
- Adding songs: 1,000 writes per day.  Listening: 100,000 reads per day.
- Player keys: Space = play/pause, Left/Right = jump 5 seconds, N = next, P = previous, F = like, / = search
