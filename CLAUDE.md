# Skimworld

WebXR (three.js + Vite + TypeScript) skimboarding world for Meta Quest 3, with a Node villager server that uses Claude.

- Read `.claude/LEARNINGS.md` first, and add to it when something fails or the user corrects you.
- `npm run dev` (game :5173, villager server :8787), `npm test` (physics), `npm run typecheck`, `npm run build`.
- The feel of skimming is the priority. `src/game/skimmer.ts` is shared by the player and NPCs. Keep `tests/physics.test.ts` green and add a test when you change a mechanic.
- `shared/world.ts` `waveHeight` is mirrored in GLSL in `src/render/ground.ts`. Change both.
- Verify visually: `?autostart`, then drive `window.__skim.step()` from the browser (see LEARNINGS).
