# Learnings — Skimworld

Friction points and the signposts that got past them. Read before working here.

## Physics tuning
- **Roller troughs flooded.** Terrain below y=0 fills to the global water table, so the Tidewell pump rollers turned into flat lakes and pumping did nothing. Fix: raise the roller band (`1.1 + 0.9 sin`) so troughs stay above 0. Signpost: when a slope feature "doesn't work", check `surfaceY` vs `terrainHeight`, since water may be flattening it.
- **Pump test needs realistic timing.** Switching crouch at slope sign changes pumps at crest/trough, where slope≈0, so the gain was tiny. Real pumping is compressed at crests and extended in troughs (crouch ∝ height phase). Tests model legs with a finite crouch rate (3/s), the same as the desktop key.
- **Throw speed.** Throwing the board faster than you run makes the hop-on unreachable. It now leaves at 0.92× run speed, 1.2 m ahead; hop ≈0.4 s after throwing to land on it.
- **Air detection.** Don't gate "leave the surface" on `vy > -2`, because riders then stuck to cliffs going downhill. Use `surfaceNext < ballistic - 0.03`.

## Rendering
- `poseAvatar` must reset `board.position` fully: the carry pose leaves an x offset, so the board floated beside the rider.
- Ground film: alpha = 1 − Fresnel reflectivity, so the mirrored sky dome (lower hemisphere) and mirrored geometry show through as reflections. Baked mirror copies need flipped triangle winding; runtime mirrors use `scale.y = -1` (three.js flips the winding itself).
- A GLSL `smoothstep(e0, e1, x)` with e0 > e1 is undefined behaviour, so use the custom `sstep`. The GLSL `waveH` must match `shared/world.ts waveHeight`.

## Tooling / environment
- The preview tool sets `PORT` for its server, so the villager server uses `NPC_PORT` (default 8787) to avoid taking Vite's port.
- `cat > file` with no heredoc hangs a Bash call waiting on stdin. Write files with the Write tool.
- The browser pane is often hidden, which throttles requestAnimationFrame. Drive the game with `window.__skim.step(n, dt)` and inject keys via `__skim.desk.keys` / `__skim.desk.pressed`. `?autostart` skips the splash.
- VR without a headset: stub `renderer.render`, force `renderer.xr.isPresenting`, call `onXR(true)`, assign fake gamepads to `xr.hands.*.gamepad`, and move `camera.position` to simulate the head. Signpost: read the head pose from the **user camera** (child of the rig). `renderer.xr.getCamera()` only refreshes at render time.

## Claude API
- `claude-opus-5-5` rejects forced `tool_choice`, so use `output_config.format` (json_schema) for structured replies. Use low effort for chat and medium for the life tick. Server-side fallback beta `server-side-fallback-2026-07-01` with `fallbacks: 'default'`.
- Without credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant` profile) the server reports offline and uses scripted lines.
- **The key lives in `~/.zshrc`**, which only interactive shells read: Claude's Bash tool and the preview tool don't see it. Start servers with `zsh -ic 'npm run dev:https'` (launch.json does this). Check with `curl localhost:8787/api/health` → `"ai":true`. Never print the key.
- Live path verified 2026-11-16: chat ≈4 s (effort low), life tick for all 14 ≈25 s (effort medium); replies stay in character and pick up threads from the life log.
- `server/data/memory.json` still holds day-1 events written by the old offline fallback ("spent the time …"); `POST /api/world/reset` clears them (and villagers' memory of the player).

## Not yet verified
- Quest setup: developer mode is switched on from the Meta Horizon phone app (needs a developer org at developers.meta.com), then accept "Allow USB debugging" in the headset. `adb` comes from `brew install android-platform-tools`. Over Wi-Fi no developer mode is needed: `dev:https` + `https://<LAN-IP>:5173`.
- Real Quest 3 hardware: frame rate, controller mapping (button indices 4/5 = A/B and X/Y), haptics, Speech APIs in the Quest Browser.

## Vercel hosting
- **Team:** deploy to `miles-wiesenthals-projects` (the Pro team, `team_YpSB…`), not the Hobby `mileswiesenthals-projects`. Signpost from the user: "whichever is my pro vercel account". Check plans with `vercel api /v2/teams/<id>` → `billing.plan`.
- `@vercel/node` emits ESM (`"type": "module"`), so relative imports in `server/` and `shared/` need `.js` extensions (TS bundler resolution and Vite both map them to `.ts`). Extensionless imports break at runtime on Vercel.
- Memory is per request on Vercel: `loadMemory()` reads the private blob (`useCache: false`) and `flushMemory()` writes it back. A life tick writes `lastTickAt` and flushes *before* the slow Claude call so other instances skip it.
- Put the key on Vercel without printing it: have `zsh -ic` write `$ANTHROPIC_API_KEY` to a 0600 temp file, `vercel env add ANTHROPIC_API_KEY production --sensitive < file`, then delete the file. Don't pipe `zsh -ic` stdout, because rc output can corrupt the value.
- `.vercelignore` must list `.env.local` (`vercel link` writes an OIDC token there).

## Mistake: wiped local memory with a stray reset
- A "check" command POSTed to `/api/world/reset` on the local server and wiped `server/data/memory.json`. I rebuilt the day-4 life events and the Tomas/Bao conversations from the chat transcript, but one later tick and the NPCs' evolved `currentLife` were lost. Signpost: **never call `/api/world/reset` to test it; test the 403 only against the hosted URL.** Local resets now write `memory.backup-<ts>.json` first.

## Quest: "Start riding" did nothing
- On the Quest browser, the splash button started flat desktop mode, which needs a keyboard, so nothing moved. Now, when `navigator.xr.isSessionSupported('immersive-vr')` is true, the button reads "Enter VR and ride" and clicks the three.js `VRButton` inside the same user gesture. Signpost: test every entry button as a headset user would, not only with `?autostart` on desktop.
- Miles reaches Skimworld through the Review Hub workshop portal (`~/Proj/review-hub/portals.json`). When the URL changes, update it there too.
- Vercel's function build prints `error TS2688: Cannot find type definition file for 'node'` after the Vite build. It's non-fatal: the deploy is Ready and the function works.

## Quest: "Enter VR and ride" still did nothing (second fix)
- Miles: "Skimworld still isn't working. Nothing happens when I press the button." The first fix clicked three's `VRButton`, which I never tested against a WebXR runtime.
- (WRONG guess, see the next section) Likely cause: three r187 `VRButton.createButton` calls `navigator.xr.offerSession` on load when it exists (Quest browser only). That pending offer can make our button's `requestSession` fail, and the rejection was swallowed.
- Fix: `VRButton` is gone. `Game.enterVR()` calls `requestSession` straight from the click handler. The splash stays up until `sessionstart`. If VR fails, the splash shows the error and a "Ride on the screen instead" button, and leaving VR brings the splash back.
- Headset diagnostics: the client POSTs `vr-click` / `vr-ok` / `vr-fail` / page errors to `/api/client-log`. Read them with `vercel logs runtime --environment production --since 10m --json --non-interactive | grep 'client]'`.
- Testing VR entry without a headset: open `xrtest.html`. It loads IWER (Meta's WebXR emulator, Quest 3 profile) and then `main.ts`. `installRuntime({ forceInstall: true })` is required, because Chrome already has `navigator.xr`. Add `?failonce` to make the first `requestSession` reject. The browser pane won't load the self-signed `dev:https` site, so run the `skimworld-web-http` launch config (Vite on http://localhost:5199) instead.
- IWER does NOT model a pending offer blocking `requestSession`, so the emulator can't prove the Quest-specific cause; the logs above can.
- Signpost: before telling Miles a headset fix works, click the real button against an emulated XR runtime (`xrtest.html`). Also give headset paths a visible error and a server log line.
- Also fixed: the splash title rendered as "SKIMWORLI". `background-clip: text` only paints inside the h1's box, and the word was wider than the 560px card.

## Quest: the real cause, a startup crash (third fix)
- Miles: "Still nothing" / "It just says Start riding and that button does nothing". The label never changed to "Enter VR and ride", so `main.ts` never got past `new Game()`.
- Evidence: `vercel logs requests` showed the Quest (OculusBrowser/157) loading `/`, the JS and the CSS, and then making zero `/api/*` calls. The game constructor calls `/api/health`, so the constructor threw.
- Cause: `Dialog`'s constructor called `speechSynthesis.getVoices()` with no guard. Speech synthesis is missing in the Quest browser, so the call threw, `new Game()` died, and no click handler was ever attached. This was the cause of the ORIGINAL "Start riding does nothing" report too. My first two fixes (flat mode needs a keyboard; the VRButton offerSession conflict) were wrong guesses.
- Reproduced in `xrtest.html?nospeech`; fixed with a guarded `synth()` helper in `src/ui/dialog.ts`.
- Safety net: an inline classic script in `index.html` defines `__skimReport` and `__skimBootError` before any module loads. Any startup error is shown on the splash and logged as `boot-fail`. Every load logs `ready immersive-vr=<bool>`. `xrtest.html?bootcrash` forces a startup crash.
- Signposts:
  - Read the server request logs BEFORE guessing. "Page loaded but no API calls" means the client crashed at startup.
  - Never touch optional browser APIs (speechSynthesis, SpeechRecognition, etc.) unguarded at startup.
  - Register error reporting before the app module runs.
  - `xrtest.html` regenerates from `index.html`: keep its head in sync after editing `index.html`.

## Ladders and villager voices on Quest
- Miles: "I can't climb ladders and the NPCs don't talk (with TTS)".
- Ladders were only decoration, and player platforms existed only for boats.
  - `shared/villages.ts` now has `deckY`, `deckAt` and `LADDERS`, mirroring `buildBuilding()` in `src/render/villages.ts`. Change both together.
  - `src/game/climb.ts` holds the pure climb logic. Start by walking into a ladder from below or off the deck's ladder edge, or in VR by squeezing grip with a hand on the rails. While climbing, the stick (or W/S) moves you, and in VR `climbPull` (a gripped hand's downward motion in rig space) lifts you hand-over-hand. Jump lets go.
  - House decks are `Platform`s with `boardable: false`. Without that, the boat rule "skim into a hull hops you aboard" would teleport a board rider up onto any house deck less than 1.8 m above.
  - Room-scale walking stays on for fixed house decks; only moving boat decks turn it off.
- Voices: the Quest browser has no `speechSynthesis`.
  - `server/voice.ts` calls Vercel AI Gateway TTS (`openai/tts-1`, one voice per villager) at `POST https://ai-gateway.vercel.sh/v4/ai/speech-model`. Auth is the project's OIDC token: the `x-vercel-oidc-token` header on Vercel, otherwise `getVercelOidcToken()`. No new key needed.
  - `/api/npc/chat` returns `voiceSig` (an HMAC of the reply, keyed from a hash of ANTHROPIC_API_KEY). `/api/npc/voice` only speaks signed lines (forged returns 403), so it can't be used as a free public TTS service.
  - Daily cap: `SKIM_DAILY_TTS` (default 400 lines); about $0.003 per line.
  - The client plays the voice through the game's AudioContext (`Audio.playVoice`) and falls back to browser speech where it exists.
  - Measured live: Claude reply + voice takes about 6 s; voicing alone about 3 s.
  - Locally `voice` is false unless `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is set.
- Testing VR grabs with IWER: `__xrdev.controllers.right.updateButtonValue('squeeze', 1)` shows up as gamepad button 1, and controller `position` is in rig-local space (`rig.worldToLocal`). Use `updateAxes('thumbstick', x, y)` for sticks. A hidden pane does NOT redraw the IWER canvas, so verify by state, or use the desktop `?autostart` view for screenshots.

## "The village is super slow" = frame rate, not physics (Nov 17)
- Signpost from Miles: "remove the slow area" → "idk like the village area is super slow". I first hunted for a physics slow zone (wading cap, deep-water bog) and asked which one. Board drag and walking speed in the village turned out identical to open sand. On Quest, "slow somewhere" means **frame rate there**: measure draw calls per location before touching physics.
- How to measure in the dev page: `__skim.player.place(x,z,0); __skim.step(5,1/72)`, then `renderer.info.autoReset=false; info.reset(); renderer.render(scene,camera)`, then read `info.render.calls`. The village was ~348 calls vs ~220 on open sand, and VR draws each eye.
- Cause: every villager is ~18 meshes, drawn twice (the wet-sand reflection `mirror` avatar), plus shadow casters. Fix: `makeAvatarLod()` in `src/render/models.ts` merges a rider's body into one vertex-coloured mesh. `Npc` shows full bodies within `AVATAR_FULL` (22 m) and full reflections within `MIRROR_FULL` (12 m), and skips posing beyond that. The village is now ~168 calls.
- The headset now logs `fps <n> <region> calls=<n> at x,z` every 20 s in VR (`vercel logs runtime … | grep 'client]'`). Use it to confirm frame-rate fixes on the real Quest.
- Hidden-pane screenshots: draw the WebGL canvas into a 2D canvas, `toDataURL('image/jpeg')`, and pad the returned string past the tool's size limit so it spills to a tool-results file. Then `jq -r '.[0].text' | cut -d'#' -f1 | base64 -d`.

## Freeform talk with villagers (Nov 17)
- The Quest browser has no `SpeechRecognition`. `src/ui/mic.ts` records with `MediaRecorder` (webm/opus) and stops ~1.3 s after you go quiet. `POST /api/npc/hear` (raw audio body, ≤1.5 MB, `audio/*` only, daily budget `SKIM_DAILY_STT`) transcribes it through AI Gateway `POST /v4/ai/transcription-model` (`ai-transcription-model-specification-version: 4`, body `{audio: base64, mediaType}`, model `openai/whisper-1`). The text then goes through the normal `/api/npc/chat`.
- In VR: hold A while a conversation is open (push-to-talk), or tap 🎤 Speak on the panel. The splash shows "Allow the mic" until permission is granted, so the prompt doesn't have to appear inside VR.
- Mic polling uses `setInterval`: window `requestAnimationFrame` doesn't run during a WebXR session.
- Testing without a mic: replace `navigator.mediaDevices.getUserMedia` with a stream from `AudioContext.createMediaStreamDestination()` that plays a villager TTS clip (from `/api/npc/voice`). Verified live: a 12.5 s clip was transcribed and Felix replied in character.

## Hop-off chains: jump off, kick it forward, jump back on
- Miles first asked: "jump off then jump back on to constantly accelerate and get to scary speeds", plus "toss it down while jumping".
- My first version was too easy: the board slid on under you and every landing was a perfect drop, so mashing the trigger reached 180 km/h. Miles: "that's too easy … u have to jump off and kick it forward, then jump back on". Signpost: a speed boost needs a timed skill input, not just a button press; check what mashing does before shipping a speed mechanic.
- Now:
  - Drop (E / right trigger) while riding faster than `KICK_OUT_BELOW` (5 m/s) hops you off, and the board slides on `loose`.
  - Drop again in the air kicks the board `KICK` (6 m/s) ahead of you. Kick in the last ~0.15 s of the ~0.55 s hop for a perfect drop; ~0.25 s gives "good". Kick earlier and the board is gone, and you tumble above 11 m/s.
  - Landing on a loose (unkicked) board is a sloppy drop (×0.86), so mashing loses speed.
  - A kicked board's boost is based on YOUR speed, not the board's. Otherwise the kick's +6 m/s compounds every cycle.
  - Slower than 5 m/s, drop still kicks out with the board in hand (NPCs rely on this).
- Drop mid-hop with the board in hand tosses it down under you (`tossUnder`).
- Drop boosts multiply speed, but `dropTaper(sp) = 1/(1+(sp/28)^2)` shrinks the bonus at speed. Well-timed chains reach ~120 km/h in 6 s and level off near 150 km/h; kicks at the top of the hop build far less.
- Test bots must kick by `airTime`: "height above the board < 0.3" fires too early, because a flat hop only rises ~0.35 m.
- Keep the Mac quiet when testing in the browser pane: suspend the game audio and close the tab afterwards. Miles had to ask another session to stop the Skimworld music.

## Owner access key (Nov 20, 2026)
- Miles: "tighten up the skimworld api unless they have my authorization key". The repo went public, and the hosted API spent his Claude and AI Gateway credits for anyone.
- `server/access.ts` `unlocked(req)` gates chat (scripted fallback, not saved), voice and hear (401), and world tick (`ran: false`). It fails closed on Vercel when `SKIM_ACCESS_KEY` is missing.
- The key is in `.env.local` (`SKIM_ACCESS_KEY`) and on Vercel production. Unlock a headset with `https://skimworld.vercel.app/#key=<key>`; the Review Hub portal URL carries it.
- Scripted replies used to push into shared `npcMemory().history`, which Claude chats later read; locked visitors must not write memory.
- `vite.config.ts` proxies `/api` to `NPC_PORT` (default 8787), so a test server can run beside another chat's dev server on 8787.
