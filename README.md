# Hype Lobby

Hype Lobby turns a Twitch stream's **Starting Soon** screen into a vote. Viewers choose which segment starts first by typing `!vote 1` in chat. Bits cheers and channel point redemptions can add weighted votes. An OBS browser overlay shows the live bars, countdown, and winner reveal.

This beginner-friendly prototype uses Node.js, Express, plain HTML/CSS/JavaScript, Twitch EventSub over WebSocket, and in-memory state. There is no database. Settings, votes, and the last summary are cleared when the server stops.

## Project pages

- `http://localhost:3000/` — Twitch connection and links to the app pages.
- `http://localhost:3000/setup` — name 3 or 4 segments, set the countdown, and start a vote.
- `http://localhost:3000/overlay` — OBS browser source with live vote bars and the winner reveal.
- `http://localhost:3000/summary` — winner, total votes, Bits and points spent, and vote breakdown.
- `http://localhost:3000/api/state` — current round state as JSON.

## What you need

- A Twitch account.
- [Node.js](https://nodejs.org/en/download/) (Node 18 or newer) and npm.
- [Git for Windows](https://git-scm.com/download/win) if you plan to push the project to GitHub.
- The [Twitch CLI](https://dev.twitch.tv/docs/cli/) is optional, but lets you test mock cheers and point redemptions without Affiliate status.
- OBS Studio if you want to show the overlay on stream.

## 1. Get Twitch app credentials

The app needs a Twitch Client ID and Client Secret for its server-side login.

1. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps) and sign in.
2. Choose **Register Your Application**.
3. Give the app a name, select a category, and add this exact OAuth Redirect URL:

   ```text
   http://localhost:3000/auth/callback
   ```

4. Save the app. Copy its **Client ID** and create/copy its **Client Secret**. Treat the secret like a password. Twitch's [app registration guide](https://dev.twitch.tv/docs/authentication/register-app/) has more detail.

Hype Lobby requests these permissions during login:

- `user:read:chat` and `channel:bot` for chat messages.
- `bits:read` for cheers.
- `channel:read:redemptions` for channel point custom reward redemptions.

If you change permissions later, disconnect and reconnect Twitch so Twitch can approve the updated list.

## 2. Create your private `.env` file

The `.env` file holds your credentials and must stay on your computer. It is ignored by Git. The safe template, `.env.example`, contains placeholders and can be shared.

In PowerShell, open the `hype-lobby` project folder and run:

```powershell
Copy-Item .env.example .env
```

This makes your private settings file from the template. Open `.env` in a text editor and replace the Client ID and Client Secret placeholders with your own values. Leave the redirect URL and port unchanged.

Do not put real credentials in `README.md`, `.env.example`, screenshots, or chat messages. Do not upload `.env` to GitHub.

## 3. Install and run Hype Lobby

Open PowerShell in the project folder. In File Explorer, open the folder, click the address bar, type `powershell`, and press Enter.

Run these commands one at a time:

```powershell
npm install
```

This downloads the packages the app needs.

```powershell
npm start
```

This starts the app. Keep the terminal open while using Hype Lobby. Open [http://localhost:3000](http://localhost:3000), choose **Connect with Twitch**, approve access, and then choose **Connect to Twitch events**.

The login token and app data are held in memory. If you stop and restart the server, connect to Twitch and EventSub again.

## 4. Set up and start a vote

1. Open [http://localhost:3000/setup](http://localhost:3000/setup).
2. Choose 3 or 4 segments, enter their names, and choose a countdown from 5 to 3,600 seconds.
3. Choose **Save setup**, then **Start Vote**. Starting a new round clears the previous round's live totals.
4. Add the overlay to OBS as a **Browser** source with this URL:

   ```text
   http://localhost:3000/overlay
   ```

   A starting browser source size of 1920 × 1080 works well.

5. When the countdown finishes, open [http://localhost:3000/summary](http://localhost:3000/summary) to review the result.

### How viewers vote

- **Free chat vote:** type `!vote 1`, `!vote 2`, and so on. Each chatter has one free vote and can change it during the round.
- **Bits:** include `!vote 2` in the cheer message to vote for segment 2.
- **Channel points:** use a custom reward whose title includes the segment number, such as `Vote 2`, or let the viewer enter `2` as reward text.
- **Weight:** every full 100 Bits or points adds one vote. A valid cheer or redemption counts for at least one vote. For example, 250 Bits adds 2 votes and a 300-point redemption adds 3.

Real cheers require Bits to be available on the channel. Real channel point custom rewards require the Twitch channel to have channel points available. Use mock mode below to demo those events without those channel features.

## 5. Test with the Twitch CLI mock server

The Twitch CLI's local EventSub mock server can send mock cheers and channel point redemptions over WebSocket. Hype Lobby detects a local WebSocket URL and skips the mock-unsupported `channel.chat.message` subscription. Use `/api/test-vote` to simulate a free chat vote in mock mode.

### Install the Twitch CLI on Windows

Twitch documents Scoop as its Windows installation method. First install [Scoop](https://scoop.sh/) using Scoop's own instructions. Then open PowerShell and run:

```powershell
scoop bucket add twitch https://github.com/twitchdev/scoop-bucket.git
```

This adds Twitch's Scoop package list.

```powershell
scoop install twitch-cli
```

This installs the Twitch CLI. Check that it works:

```powershell
twitch --version
```

See Twitch's [CLI installation guide](https://dev.twitch.tv/docs/cli/) if you need another install method.

### Switch from real Twitch to mock mode

1. Stop Hype Lobby by clicking its terminal window and pressing **Ctrl+C**.
2. Open the existing `.env` file. Keep your Client ID, Client Secret, redirect URL, and port. Change only the EventSub URLs to:

   ```text
   EVENTSUB_WEBSOCKET_URL=ws://127.0.0.1:8080/ws
   EVENTSUB_SUBSCRIPTIONS_URL=http://127.0.0.1:8080/eventsub/subscriptions
   MOCK_DEFAULT_SEGMENT=1
   ```

   `MOCK_DEFAULT_SEGMENT=1` gives generated mock cheers a destination because the CLI cheer does not include a viewer-written chat message. You can use `2`, `3`, or `4` instead.

3. In a second PowerShell window opened in the project folder, run:

   ```powershell
   twitch event websocket start-server
   ```

   Leave this terminal open. It runs the local mock EventSub server on port 8080.

4. In the first terminal, start Hype Lobby again:

   ```powershell
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000), reconnect with Twitch, and choose **Connect to Twitch events**. The app should say it skipped the chat subscription and subscribed to mock Bits and points.
6. Open [http://localhost:3000/setup](http://localhost:3000/setup), save your segments/countdown, and choose **Start Vote**.

### Send mock votes

In a third PowerShell window, run these commands while a round is active:

```powershell
twitch event trigger channel.cheer --cost 250 --transport=websocket
```

This sends a mock 250-Bit cheer, which adds 2 votes to the `MOCK_DEFAULT_SEGMENT`.

```powershell
twitch event trigger channel.channel_points_custom_reward_redemption.add --cost 300 --item-name "Vote 2" --transport=websocket
```

This sends a 300-point redemption whose reward title selects segment 2, adding 3 votes there.

To simulate a free chat command, open another PowerShell window and run:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/test-vote -ContentType "application/json" -Body '{"message":"!vote 2","viewer":"Mock Viewer"}'
```

This sends the mock equivalent of `!vote 2`. Use a different `viewer` value to simulate another chatter. This endpoint only responds when the local mock WebSocket URL is configured.

Check the live overlay or visit [http://localhost:3000/api/state](http://localhost:3000/api/state) to see vote and spending totals. The Twitch CLI also documents [mock WebSocket events and reconnect testing](https://dev.twitch.tv/docs/cli/websocket-event-command/).

### Switch back to real Twitch

1. Stop Hype Lobby with **Ctrl+C**.
2. In `.env`, restore the real EventSub URLs:

   ```text
   EVENTSUB_WEBSOCKET_URL=wss://eventsub.wss.twitch.tv/ws
   EVENTSUB_SUBSCRIPTIONS_URL=https://api.twitch.tv/helix/eventsub/subscriptions
   ```

3. Start Hype Lobby again with `npm start`, then reconnect with Twitch and choose **Connect to Twitch events**.
4. You can stop the Twitch CLI mock server with **Ctrl+C** in its terminal.

## 6. Push the project to GitHub safely

These steps create a new GitHub repository and upload the project files. The `.env` file is ignored by `.gitignore`; confirm it is ignored before staging files.

### Create an empty GitHub repository

1. Sign in to [GitHub](https://github.com/) and choose **New repository**.
2. Name it `hype-lobby`.
3. Choose **Public** for a public hackathon project or **Private** if you want to restrict access.
4. Leave **Add a README**, **Add .gitignore**, and **Choose a license** unchecked. The project already has local files for these.
5. Create the repository and leave its page open. Copy the HTTPS repository address. It looks like `https://github.com/YOUR-USERNAME/hype-lobby.git`.

### Prepare and upload the local project

Install [Git for Windows](https://git-scm.com/download/win) if `git --version` is not recognized. Open PowerShell in the `hype-lobby` folder, then run these commands one at a time:

```powershell
git init
```

This creates a local Git repository for the project.

```powershell
git check-ignore -v .env
```

This checks that `.env` is ignored. The output should name `.gitignore` and the `.env` rule. If it prints nothing, stop and check that `.gitignore` contains a line with `.env` before continuing.

```powershell
git status --short
```

This shows files Git can see. `.env` should not appear.

```powershell
git add .
```

This stages the project files for the first upload. Git skips `.env` because it is ignored.

```powershell
git status --short
```

Review the staged files. Make sure `.env` is not listed before committing. `.env.example` is safe to upload because it contains placeholders.

```powershell
git commit -m "Build Hype Lobby Twitch voting app"
```

This saves the staged project files into a local commit.

```powershell
git branch -M main
```

This names the main branch `main`.

Add your GitHub repository address, replacing `YOUR-USERNAME` with your GitHub username:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/hype-lobby.git
```

This connects the local project to the GitHub repository. If GitHub created a different repository name, use the address shown on its page.

```powershell
git push -u origin main
```

This uploads the commit to GitHub. Git Credential Manager may open a browser so you can sign in. GitHub does not accept your account password in the Git password prompt; use the browser sign-in or a supported token flow.

After the first push, future updates use:

```powershell
git add .
git commit -m "Describe your change"
git push
```

### If `.env` was ever committed

Do not push it. Remove it from Git's tracking with `git rm --cached .env`, make sure `.env` remains in `.gitignore`, then commit that removal. If a real Client Secret was uploaded or shared, create a new secret in the Twitch Developer Console; deleting a file from the latest version does not make an already exposed secret private again.

## Notes

- All vote state and settings live in memory and reset when the app stops.
- EventSub reconnects automatically after a dropped connection. Twitch text keepalive messages need no reply; the WebSocket library answers WebSocket Ping frames.
- The Twitch CLI mock mode supports cheer and channel point events. For free mock chat votes, use `/api/test-vote` because the CLI mock does not implement `channel.chat.message`.
