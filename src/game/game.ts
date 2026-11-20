import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { clamp, wrapAngle } from '../../shared/noise';
import { deckAt, GEAR_SPOTS } from '../../shared/villages';
import { ladderToClimb, startClimb, stepClimb, type ClimbState, type Vec3 } from './climb';
import { LIFT, MESA, REGIONS, regionWeights, SPAWN, surfaceY, windAt, type RegionId } from '../../shared/world';
import { Audio } from '../audio/audio';
import { api } from '../net/api';
import { Spray, Wake, WindStreaks, Gulls, makeThermals, makeWaterfalls } from '../render/effects';
import { Ground } from '../render/ground';
import { makeAvatar, makeBoard, makeSail, makeWing, poseAvatar, type Avatar } from '../render/models';
import { SkySystem } from '../render/sky';
import { buildVillages, drawNotice, type VillageDynamics } from '../render/villages';
import { Dialog } from '../ui/dialog';
import { Hud } from '../ui/hud';
import { Fleet } from './boats';
import type { Platform } from './skimmer';
import { DesktopInput, XRInput, type Actions, type Continuous } from './input';
import type { Npc } from './npcs';
import { Villagers } from './npcs';
import { emptyInput, Skimmer, type SkimEvent } from './skimmer';

const PLAYER_LOOK = { skin: '#d8a47f', hair: '#2b2118', hairStyle: 'short' as const, top: '#ffb703', bottom: '#023047', board: '#00b4d8', height: 1.75 };

const TELEPORTS: Array<{ x: number; z: number; h: number }> = [
  { x: SPAWN.x, z: SPAWN.z, h: SPAWN.heading },
  { x: 820, z: -120, h: Math.PI / 2 },
  { x: -250, z: 820, h: 0 },
  { x: -860, z: -500, h: 0.6 },
  { x: 600, z: 700, h: 0.7 },
];

function loadGear(): { sail: boolean; wing: boolean } {
  try {
    return { sail: false, wing: false, ...JSON.parse(localStorage.getItem('skim.gear') ?? '{}') };
  } catch {
    return { sail: false, wing: false };
  }
}

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(65, 1, 0.05, 5000);
  rig = new THREE.Group();
  sky: SkySystem;
  ground: Ground;
  village: VillageDynamics;
  spray = new Spray();
  wake = new Wake();
  wind = new WindStreaks();
  falls = makeWaterfalls();
  thermals = makeThermals();
  gulls = new Gulls([
    [0, 0, 22],
    [-250, 900, 18],
    [-900, -550, 60],
  ]);
  fleet: Fleet;
  villagers: Villagers;
  player = new Skimmer(1.0);
  avatar: Avatar;
  avatarMirror: Avatar;
  thrownBoard: THREE.Mesh;
  thrownMirror: THREE.Mesh;
  vrBoard: THREE.Mesh;
  vrBoardMirror: THREE.Mesh;
  vrCarry: THREE.Mesh;
  sail = makeSail();
  wing = makeWing('#ffb703');
  audio = new Audio();
  desk: DesktopInput;
  xr: XRInput;
  hud: Hud;
  dialog: Dialog;

  time = 0;
  hour = 16.4;
  day = 1;
  timeScale = 1;
  private lastTickHour = -1;
  private clockReady = false; // wait for the server's saved world clock before ticking lives
  private hourInt = -1;
  private last = performance.now();
  private camYaw = SPAWN.heading;
  private feats: Array<{ t: number; text: string }> = [];
  private region: RegionId | null = null;
  private lift: { t: number; dir: 'up' | 'down' } | null = null;
  private liftCooldown = 0;
  private climb: ClimbState | null = null;
  private climbCooldown = 0;
  private decks = new Map<string, Platform>();
  /** What the player can stand on: moving boat decks, then the stilt-house decks. */
  private platformAt = (x: number, z: number): Platform | null => {
    const boat = this.fleet.platformAt(x, z);
    if (boat) return boat;
    const d = deckAt(x, z);
    if (!d) return null;
    let plat = this.decks.get(d.bd.id);
    if (!plat) {
      plat = { id: d.bd.id, y: d.y, vx: 0, vz: 0, yawRate: 0, cx: d.bd.x, cz: d.bd.z, boardable: false };
      this.decks.set(d.bd.id, plat);
    }
    return plat;
  };
  private hapticT = 0;
  private rippleT = 0;
  private hintsSeen = new Set<string>();
  private aiText = 'connecting to villagers…';
  private leanCenter = 0;
  private started = false;
  private ray = new THREE.Raycaster();
  private vignette: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private vigAmt = 0;
  private lastRigYaw = 0;
  private lastSpeed = 0;
  frameCount = 0;
  fps = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  private fpsLogAt = 0;
  private talkHeld = false;

  constructor(private container: HTMLElement) {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local-floor');
    r.xr.setFoveation(1);
    container.appendChild(r.domElement);
    this.renderer = r;

    this.scene.add(this.rig);
    this.rig.add(this.camera);

    this.sky = new SkySystem(this.scene, true);
    this.ground = new Ground(48, 2);
    this.scene.add(this.ground.group);
    this.village = buildVillages(this.scene);
    this.scene.add(this.spray.points, this.wake.mesh, this.wind.lines, this.falls.mesh, this.thermals.points, this.gulls.group);
    this.fleet = new Fleet(this.scene);
    this.villagers = new Villagers(this.scene, this.hour, this.fleet);
    this.hourInt = Math.floor(this.hour);

    this.avatar = makeAvatar(PLAYER_LOOK);
    this.avatarMirror = makeAvatar(PLAYER_LOOK);
    this.avatarMirror.root.traverse((o) => (o.castShadow = false));
    this.scene.add(this.avatar.root, this.avatarMirror.root);
    this.thrownBoard = makeBoard(PLAYER_LOOK.board);
    this.thrownMirror = makeBoard(PLAYER_LOOK.board);
    this.vrBoard = makeBoard(PLAYER_LOOK.board);
    this.vrBoardMirror = makeBoard(PLAYER_LOOK.board);
    this.vrCarry = makeBoard(PLAYER_LOOK.board);
    this.scene.add(this.thrownBoard, this.thrownMirror, this.vrBoard, this.vrBoardMirror);
    this.vrBoard.visible = this.vrBoardMirror.visible = false;
    this.scene.add(this.sail, this.wing);
    this.sail.visible = this.wing.visible = false;

    const gear = loadGear();
    this.player.hasSail = gear.sail;
    this.player.hasWing = gear.wing;
    this.player.place(SPAWN.x, SPAWN.z, SPAWN.heading);

    this.desk = new DesktopInput(r.domElement);
    this.xr = new XRInput(r, this.rig);
    const factory = new XRControllerModelFactory();
    for (const h of [this.xr.hands.left, this.xr.hands.right]) h.grip.add(factory.createControllerModel(h.grip as THREE.Group));
    const rayLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]),
      new THREE.LineBasicMaterial({ color: '#8fe9df', transparent: true, opacity: 0.6 }),
    );
    rayLine.name = 'pointer';
    rayLine.visible = false;
    this.xr.hands.right.ray.add(rayLine);
    this.vrCarry.rotation.set(Math.PI / 2, 0, 0);
    this.vrCarry.position.set(0.05, -0.05, 0.1);
    this.vrCarry.scale.setScalar(0.9);
    this.xr.hands.right.grip.add(this.vrCarry);

    // VR comfort: the view narrows a little during fast rig rotation / hard accel
    this.vignette = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uAmt: { value: 0 } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader:
          'uniform float uAmt; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float inner = 1.05 - uAmt * 0.75; gl_FragColor = vec4(0.02, 0.06, 0.08, smoothstep(inner, inner + 0.35, d) * min(1.0, uAmt * 1.6)); }',
      }),
    );
    this.vignette.position.z = -0.2;
    this.vignette.renderOrder = 100;
    this.vignette.frustumCulled = false;
    this.vignette.visible = false;
    this.camera.add(this.vignette);

    this.hud = new Hud(this.scene);
    this.xr.hands.left.grip.add(this.hud.wrist.mesh);
    this.hud.wrist.mesh.position.set(0.0, 0.06, 0.08);
    this.hud.wrist.mesh.rotation.set(-Math.PI / 2 + 0.6, 0, 0);
    this.dialog = new Dialog(
      () => ({
        hour: this.hour,
        day: this.day,
        playerName: localStorage.getItem('skim.name') ?? undefined,
        playerRegion: this.region ?? undefined,
        feats: this.feats.filter((f) => this.time - f.t < 90).slice(-4).map((f) => f.text),
        gear: [this.player.hasSail ? 'a sail from June' : '', this.player.hasWing ? 'a glide wing from Sora' : ''].filter(Boolean),
      }),
      () => undefined,
      { play: (mp3) => this.audio.playVoice(mp3), stop: () => this.audio.stopVoice() },
    );
    this.scene.add(this.dialog.panel.mesh);

    r.xr.addEventListener('sessionstart', () => this.onXR(true));
    r.xr.addEventListener('sessionend', () => this.onXR(false));

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.ground.update(new THREE.Vector3(this.player.x, 0, this.player.z), 0, 0.85, 0, 0, true);

    void api.health().then((h) => {
      // Resume the shared world clock: the server remembers when lives last advanced, so a fresh
      // page starts on a later day instead of day 1 (otherwise lives freeze until we catch up).
      if (h?.clock) {
        const last = h.clock.day * 24 + h.clock.hour;
        while (this.day * 24 + this.hour < last + 6) this.day++;
      }
      this.clockReady = true;
      this.aiText = !h ? 'villager server offline — run npm run dev' : h.ai ? `villager minds: Claude (${h.model})` : 'villagers scripted — add ANTHROPIC_API_KEY for live minds';
    });
    void this.refreshNews();
    (window as unknown as { __skim: Game }).__skim = this;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.audio.start();
    this.hud.pop('SKIMWORLD', 'region');
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /**
   * Enter VR. Call it straight from a click handler: the browser only allows the request inside
   * the user's gesture. We request the session ourselves instead of using three's VRButton,
   * because VRButton also calls navigator.xr.offerSession on load (Quest browser), and that
   * pending offer can make our button's request fail silently.
   */
  enterVR(): Promise<void> {
    const xr = navigator.xr;
    if (!xr) return Promise.reject(new Error('This browser has no WebXR.'));
    return xr
      .requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] })
      .then((session) => this.renderer.xr.setSession(session));
  }

  /** Automation/testing: advance n fixed-size frames (works with a hidden tab). */
  step(n = 1, dt = 1 / 60) {
    for (let i = 0; i < n; i++) {
      this.last = performance.now() - dt * 1000;
      this.frame(performance.now());
    }
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private get inXR() {
    return this.renderer.xr.isPresenting;
  }

  private onXR(on: boolean) {
    this.audio.start();
    this.sky.sun.castShadow = !on;
    this.avatar.root.visible = !on;
    this.avatarMirror.root.visible = !on;
    if (on) {
      this.rig.position.set(this.player.x, this.player.y, this.player.z);
      this.rig.rotation.set(0, this.player.heading + Math.PI, 0);
      this.camera.position.set(0, 0, 0);
      this.camera.rotation.set(0, 0, 0);
    } else {
      this.rig.position.set(0, 0, 0);
      this.rig.rotation.set(0, 0, 0);
    }
  }

  // ------------------------------------------------------------------ frame
  private frame(now: number) {
    const dt = clamp((now - this.last) / 1000, 0.0005, 0.05);
    this.last = now;
    this.frameCount++;
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
      // No console on the Quest: send the headset frame rate per region to the server log.
      if (this.inXR && this.time > this.fpsLogAt) {
        this.fpsLogAt = this.time + 20;
        const w = window as unknown as { __skimReport?: (e: string, d: string) => void };
        w.__skimReport?.('fps', `${this.fps.toFixed(0)} ${this.region ?? '?'} calls=${this.renderer.info.render.calls} at ${Math.round(this.player.x)},${Math.round(this.player.z)}`);
      }
    }
    this.time += dt;
    this.advanceClock(dt);

    const p = this.player;
    const xr = this.inXR;
    const { actions, cont } = xr ? this.xr.read(dt, this.camera, p.mode === 'air', p.mode === 'foot') : this.desk.read(dt, p.mode === 'air');
    this.handleActions(actions, cont, dt);
    // Push-to-talk with A while a conversation is open.
    if (xr && this.dialog.open && cont.talkHold !== this.talkHeld) {
      if (cont.talkHold) this.dialog.listen();
      else this.dialog.stopListening();
    }
    this.talkHeld = cont.talkHold;

    // build physics input
    const inp = emptyInput();
    inp.moveX = cont.moveX;
    inp.moveY = cont.moveY;
    inp.run = cont.run;
    inp.crouch = cont.crouch;
    inp.jump = actions.jump && !this.dialog.open;
    inp.drop = actions.drop;
    inp.sail = actions.sail;
    inp.spin = cont.spin;
    inp.wing = cont.wing;
    inp.pitch = cont.pitch;
    inp.sailTrimOffset = cont.sailTrimOffset;
    inp.sailTrim = cont.sailWorldYaw !== null ? wrapAngle(cont.sailWorldYaw - p.heading) : null;
    if (xr) {
      inp.viewYaw = this.xr.headYaw;
      inp.lean = this.bodyLean(dt) + cont.leanAssist * 0.7;
    } else {
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      inp.viewYaw = Math.atan2(d.x, d.z);
      inp.lean = cont.leanAssist;
    }
    if (this.dialog.open && !xr) {
      inp.moveX = inp.moveY = 0;
    }

    // room-scale walking: everywhere except moving boat decks (fixed house decks are fine)
    if (xr && p.mode === 'foot' && !this.lift && !this.climb && (!p.platform || this.decks.has(p.platform.id))) {
      p.x = this.xr.headWorld.x;
      p.z = this.xr.headWorld.z;
    }
    const bx = p.x;
    const bz = p.z;
    const bh = p.heading;

    if (this.lift) this.updateLift(dt);
    else if (this.climb) this.updateClimb(dt, xr ? cont.climbStick : cont.moveY * this.climb.dir, xr ? cont.climbPull : 0, actions.jump);
    else {
      p.time = this.time - dt;
      p.update(dt, inp, this.platformAt);
    }
    for (const e of p.events) this.onPlayerEvent(e);
    p.events.length = 0;

    if (xr) {
      this.rig.position.x += p.x - bx;
      this.rig.position.z += p.z - bz;
      this.rig.position.y = p.y;
      const dh = p.riding || p.platform ? wrapAngle(p.heading - bh) : 0;
      if (dh) this.rotateRigAround(p.x, p.z, dh);
      if (cont.snapTurn) {
        const head = this.xr.headWorld;
        this.rotateRigAround(head.x, head.z, -cont.snapTurn * (Math.PI / 4));
      }
    }

    this.updateWorld(dt);
    this.updatePlayerVisuals(dt);
    if (!xr) this.updateCamera(dt);
    this.updateFeedback(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private rotateRigAround(cx: number, cz: number, ang: number) {
    const ox = this.rig.position.x - cx;
    const oz = this.rig.position.z - cz;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    this.rig.position.x = cx + ox * c + oz * s;
    this.rig.position.z = cz - ox * s + oz * c;
    this.rig.rotation.y += ang;
  }

  /** VR carving: how far your head sits toward the board's right rail. */
  private bodyLean(dt: number): number {
    const p = this.player;
    if (!p.riding) {
      this.leanCenter = 0;
      return 0;
    }
    const head = this.xr.headWorld;
    const rx = -Math.cos(p.heading);
    const rz = Math.sin(p.heading);
    const off = (head.x - p.x) * rx + (head.z - p.z) * rz;
    this.leanCenter += (off - this.leanCenter) * Math.min(1, dt * 0.12);
    const l = off - this.leanCenter;
    const dead = 0.025;
    return clamp((Math.sign(l) * Math.max(0, Math.abs(l) - dead)) / 0.14, -1, 1);
  }

  private advanceClock(dt: number) {
    this.hour += (dt / 60) * this.timeScale;
    if (this.hour >= 24) {
      this.hour -= 24;
      this.day++;
    }
    const hi = Math.floor(this.hour);
    if (hi !== this.hourInt) {
      this.hourInt = hi;
      this.villagers.setHour(this.hour);
    }
    if (this.clockReady && (this.lastTickHour < 0 || this.day * 24 + hi - this.lastTickHour >= 6)) {
      this.lastTickHour = this.day * 24 + hi;
      void api.tick(this.day, this.hour).then(() => this.refreshNews()).catch(() => undefined);
    }
  }

  private async refreshNews() {
    const events = await api.news();
    const byRegion = new Map<string, string[]>();
    for (const e of events.slice().reverse()) {
      const arr = byRegion.get(e.region) ?? [];
      if (arr.length < 4) arr.push(`${e.npcId[0].toUpperCase() + e.npcId.slice(1)}: ${e.text}`);
      byRegion.set(e.region, arr);
    }
    for (const [region, lines] of byRegion) drawNotice(region as RegionId, lines, this.village.notices);
  }

  private headInfo() {
    const pos = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.camera.getWorldPosition(pos);
    this.camera.getWorldDirection(dir);
    return { pos, dir };
  }

  private handleActions(a: Actions, _c: Continuous, dt: number) {
    if (a.help) this.hud.toggleHelp();
    if (a.mute) this.audio.setMuted(!this.audio.muted);
    if (a.timeShift) {
      this.hour = (this.hour + a.timeShift * 2 + 24) % 24;
      this.villagers.setHour(this.hour);
    }
    if (a.respawn) this.teleport(0);
    if (a.teleport) this.teleport(a.teleport - 1);

    // VR pointer at the dialog panel
    const pointer = this.xr.hands.right.ray.getObjectByName('pointer');
    if (pointer) pointer.visible = this.inXR && this.dialog.open;
    if (this.inXR && this.dialog.open) {
      const ctrl = this.xr.hands.right.ray;
      const origin = new THREE.Vector3();
      const dir = new THREE.Vector3(0, 0, -1);
      ctrl.getWorldPosition(origin);
      dir.applyQuaternion(ctrl.getWorldQuaternion(new THREE.Quaternion()));
      this.ray.set(origin, dir);
      const hit = this.ray.intersectObject(this.dialog.panel.mesh)[0];
      const id = hit?.uv ? this.dialog.panel.hitTest(hit.uv) : null;
      if (id !== this.dialog.panel.hover) {
        this.dialog.panel.hover = id;
        this.dialog.render();
        if (id) this.xr.pulse('right', 0.2, 20);
      }
      if (hit && a.select) {
        if (id) this.dialog.pick(id);
        a.drop = false;
      }
    }

    if (a.talk) {
      if (this.dialog.open) this.dialog.close();
      else {
        const n = this.villagers.nearest(this.playerPos(), 7);
        if (n) {
          n.startTalk(this.playerPos());
          this.dialog.start(n);
          const to = Math.atan2(n.sk.x - this.player.x, n.sk.z - this.player.z);
          this.player.heading = to;
          this.camYaw = to - 0.5;
          this.desk.orbitYaw = 0;
        }
      }
    }
    void dt;
  }

  private teleport(i: number) {
    const t = TELEPORTS[i];
    if (!t) return;
    this.lift = null;
    this.player.place(t.x, t.z, t.h);
    if (this.inXR) {
      this.rig.position.set(t.x, this.player.y, t.z);
    }
    this.ground.update(new THREE.Vector3(t.x, 0, t.z), this.time, 0.85, 0, 0, true);
  }

  playerPos() {
    return new THREE.Vector3(this.player.x, this.player.y, this.player.z);
  }

  // ------------------------------------------------------------------ events
  private feat(text: string) {
    this.feats.push({ t: this.time, text });
    if (this.feats.length > 12) this.feats.shift();
  }

  private onPlayerEvent(e: SkimEvent) {
    const head = this.inXR ? this.headInfo() : undefined;
    const p = this.player;
    const a = this.audio;
    switch (e.type) {
      case 'perfect-drop':
        this.hud.pop(`PERFECT DROP  ${Math.round(e.value * 3.6)} km/h`, 'big', head);
        a.chime(2);
        a.splash(0.8);
        this.xr.pulse('both', 0.8, 90);
        this.burst(p.x, p.y, p.z, 26, 2.5);
        this.feat('nailed a perfect drop');
        break;
      case 'good-drop':
        this.hud.pop('Clean drop', 'small', head);
        a.chime(0);
        a.splash(0.5);
        this.xr.pulse('both', 0.5, 60);
        this.burst(p.x, p.y, p.z, 14, 1.6);
        break;
      case 'sloppy-drop':
        if (e.text?.startsWith('Kick')) this.hud.pop(this.inXR ? 'Trigger again just before you land: kick it forward' : 'E again just before you land: kick it forward', 'small', head);
        else this.hint('sloppy', 'Hop (Space / A) just BEFORE you reach the board to land on it');
        a.splash(0.4);
        break;
      case 'pump':
        this.hud.pop('Pump!', 'small', head);
        a.whoosh(0.5);
        this.xr.pulse('both', 0.35, 40);
        break;
      case 'ollie':
        a.whoosh(1);
        this.xr.pulse('both', 0.4, 40);
        this.burst(p.x, p.y, p.z, 10, 1.2);
        break;
      case 'launch':
        a.whoosh(1.4);
        break;
      case 'stomp':
        this.hud.pop('STOMPED', 'big', head);
        a.chime(1);
        a.thud();
        this.xr.pulse('both', 0.9, 80);
        this.feat(`stomped a landing after ${p.airTime.toFixed(1)}s of air`);
        break;
      case 'land':
        this.hint('land', 'Crouch (Shift / bend knees) as you land to stomp it');
        a.thud();
        this.xr.pulse('both', 0.7, 60);
        break;
      case 'trick':
        this.hud.pop(e.text ?? 'Trick', 'big', head);
        a.chime(3);
        this.feat(`landed a ${e.text}`);
        break;
      case 'switch':
        this.hud.pop('Switch!', 'small', head);
        break;
      case 'wipeout':
        this.hud.pop(e.text ?? 'Wipeout', 'big', head);
        a.splash(2.5);
        a.thud();
        this.xr.pulse('both', 1, 300);
        this.burst(p.x, p.y, p.z, 60, 4);
        this.feat('wiped out spectacularly');
        break;
      case 'bog':
        if (p.speed < 1.2) this.hint('bog', 'Too slow to plane — run, throw the board, hop on');
        break;
      case 'splash':
        this.ground.ripple(e.x, e.z, Math.min(2.5, 0.4 + e.value * 0.4), this.time);
        a.splash(e.value);
        this.burst(e.x, p.y, e.z, Math.floor(6 + e.value * 10), 1 + e.value * 0.6);
        if (e.text) this.hud.pop(e.text, 'small', head);
        break;
      case 'step':
        this.ground.ripple(e.x, e.z, 0.35, this.time);
        a.step(e.value);
        this.spray.emit(e.x, p.y + 0.02, e.z, p.vx * 0.2, 0.8, p.vz * 0.2, 3, 0.8, 0.05, 0.4);
        break;
      case 'throw':
        a.whoosh(0.6);
        if (e.text) this.hud.pop(e.text, 'small', head);
        this.ground.ripple(p.board.x, p.board.z, 0.8, this.time);
        break;
      case 'aboard':
        this.hud.pop(e.text ?? 'Aboard', 'small', head);
        a.thud();
        this.feat('hopped aboard a skimboat');
        break;
      case 'glide':
        this.hud.pop('Wing out — ride the thermals', 'small', head);
        this.feat('glided on a wing');
        break;
      case 'sail':
        this.hud.pop(e.text ?? 'Sail', 'small', head);
        break;
      case 'pickup':
      case 'mispump':
        break;
    }
  }

  private burst(x: number, y: number, z: number, n: number, sp: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spray.emit(x, y + 0.05, z, Math.cos(a) * sp, sp * 0.9, Math.sin(a) * sp, 1, 0.8, 0.09, 1.0);
    }
  }

  private hint(key: string, text: string) {
    const n = [...this.hintsSeen].filter((k) => k === key).length;
    if (n) return;
    this.hintsSeen.add(key);
    this.hud.pop(text, 'small', this.inXR ? this.headInfo() : undefined);
  }

  // ------------------------------------------------------------------ world
  private updateWorld(dt: number) {
    const p = this.player;
    const pos = this.playerPos();
    this.fleet.update(dt, this.time);
    this.villagers.update(dt, this.time, pos, {
      onEvent: (n: Npc, e: SkimEvent) => {
        const d = Math.hypot(n.sk.x - p.x, n.sk.z - p.z);
        if (d > 90) return;
        if (e.type === 'splash' || e.type === 'perfect-drop' || e.type === 'wipeout' || e.type === 'stomp') {
          this.ground.ripple(e.x, e.z, 1, this.time);
          if (d < 50) this.burst(e.x, n.sk.y, e.z, 12, 1.6);
        }
      },
    });

    // ripple trails from riders
    this.rippleT -= dt;
    if (this.rippleT <= 0) {
      this.rippleT = 0.16;
      if (p.mode === 'board') this.ground.ripple(p.x, p.z, clamp(p.speed * 0.05, 0.15, 0.7), this.time);
      for (const n of this.villagers.list) {
        if (n.sk.mode !== 'board') continue;
        const d = Math.hypot(n.sk.x - p.x, n.sk.z - p.z);
        if (d < 70 && Math.random() < 0.35) this.ground.ripple(n.sk.x, n.sk.z, 0.4, this.time);
      }
      for (const b of this.fleet.boats) {
        if (Math.hypot(b.x - p.x, b.z - p.z) < 160) {
          const w = b.world(0, -16);
          this.ground.ripple(w.x, w.z, 1.2, this.time);
        }
      }
    }

    // gear
    for (const pk of this.village.pickups) {
      pk.obj.rotation.y += dt * 0.8;
      const d = Math.hypot(pk.x - p.x, pk.z - p.z);
      if (d < 4) {
        if (pk.kind === 'sail' && !p.hasSail) {
          p.hasSail = true;
          this.hud.pop('Got a SAIL — F / X to raise it, trim with Z/X or your left hand', 'big', this.inXR ? this.headInfo() : undefined);
          this.audio.chime(3);
          this.saveGear();
          this.feat('picked up a sail from June\'s loft');
        }
        if (pk.kind === 'wing' && !p.hasWing) {
          p.hasWing = true;
          this.hud.pop('Got a GLIDE WING — hold G / spread your arms in the air', 'big', this.inXR ? this.headInfo() : undefined);
          this.audio.chime(3);
          this.saveGear();
          this.feat('picked up a glide wing from Sora');
        }
      }
    }

    // the Mist Lift
    this.liftCooldown = Math.max(0, this.liftCooldown - dt);
    if (!this.lift && p.mode === 'foot' && this.liftCooldown <= 0) {
      if (Math.hypot(p.x - LIFT.base.x, p.z - LIFT.base.z) < LIFT.radius) this.lift = { t: 0, dir: 'up' };
      else if (Math.hypot(p.x - LIFT.top.x, p.z - LIFT.top.z) < LIFT.radius && p.y > 30) this.lift = { t: 0, dir: 'down' };
      if (this.lift) this.hud.pop('Mist Lift', 'small', this.inXR ? this.headInfo() : undefined);
    }

    // ladders up to the stilt-house decks
    this.climbCooldown = Math.max(0, this.climbCooldown - dt);
    if (!this.climb && !this.lift && p.mode === 'foot' && this.climbCooldown <= 0) {
      const grabbing: Vec3[] = [];
      if (this.inXR) {
        for (const h of [this.xr.hands.left, this.xr.hands.right]) {
          if (h.buttons[1]) grabbing.push(h.grip.getWorldPosition(new THREE.Vector3()));
        }
      }
      const onDeck = p.platform && this.decks.has(p.platform.id) ? p.platform.id : null;
      const found = ladderToClimb(p, p.vx, p.vz, onDeck, grabbing);
      if (found) {
        this.climb = startClimb(found.ladder, found.dir);
        this.hint('climb', this.inXR ? 'Climbing: pull down with a gripped hand, or push the stick. Jump to let go.' : 'Climbing: W/S to climb, Space to let go.');
        if (this.inXR) this.xr.pulse('both', 0.4, 40);
      }
    }

    // village life
    const night = this.sky.night;
    for (const g of this.village.glowMats) g.m.emissiveIntensity = g.base * (g.always ? 1 : 0.12 + night * 0.88);
    for (const r of this.village.rotors) r.rotation.z -= dt * (r.userData.speed as number);
    for (const [i, f] of this.village.flames.entries()) {
      f.scale.y = 1 + Math.sin(this.time * (9 + i * 3)) * 0.18 + Math.random() * 0.1;
      f.rotation.y += dt * 2;
    }
    this.village.fireLight.intensity = (0.3 + night * 3.5) * (0.85 + Math.random() * 0.15) * 30;
    this.gulls.update(this.time);
    this.falls.uniforms.uTime.value = this.time;
    this.thermals.uniforms.uTime.value = this.time;

    // waterfall mist
    for (const s of this.falls.spots) {
      if (Math.hypot(s.x - p.x, s.z - p.z) < 130 && Math.random() < 0.5) {
        this.spray.emit(s.x + (Math.random() - 0.5) * 8, 0.3, s.z + (Math.random() - 0.5) * 8, 0, 2.5, 0, 2, 3, 0.5, 2.2);
      }
    }

    // regions + vibe
    const w = regionWeights(p.x, p.z);
    let best: RegionId | null = null;
    let bw = 0.6;
    for (const id of Object.keys(w) as RegionId[])
      if (w[id] > bw) {
        bw = w[id];
        best = id;
      }
    if (best && best !== this.region) {
      this.region = best;
      const r = REGIONS.find((x) => x.id === best)!;
      this.hud.pop(`${r.name} — ${r.tagline}`, 'region', this.inXR ? this.headInfo() : undefined);
    }
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    this.sky.update(this.hour, this.time, camPos, w);
    const v = this.sky.vibe;
    this.ground.update(pos, this.time, v.mirror, v.glow, w.saltglass, false);
    this.spray.uniforms.uGlow.value = v.glow * 0.8;
    this.wake.uniforms.uGlow.value = v.glow;
    const scale = this.inXR ? 900 : this.renderer.domElement.height * 0.5;
    this.spray.uniforms.uScale.value = scale;
    this.thermals.uniforms.uScale.value = scale;
    this.wind.update(dt, pos, this.time, p.y);
  }

  private saveGear() {
    try {
      localStorage.setItem('skim.gear', JSON.stringify({ sail: this.player.hasSail, wing: this.player.hasWing }));
    } catch {
      /* private mode */
    }
  }

  private updateClimb(dt: number, up: number, pull: number, letGo: boolean) {
    const st = this.climb!;
    const L = st.ladder;
    const p = this.player;
    if (letGo) {
      // drop off: the next foot step finds nothing underfoot and falls
      this.climb = null;
      this.climbCooldown = 1;
      return;
    }
    const step = stepClimb(st, dt, up, pull);
    p.vx = p.vy = p.vz = 0;
    p.mode = 'foot';
    p.riding = false;
    p.platform = null;
    if (step.at === 'top') {
      p.x = L.topX;
      p.z = L.topZ;
      p.y = L.topY;
      p.heading = Math.atan2(-L.nx, -L.nz); // facing onto the deck
      this.climb = null;
      this.climbCooldown = 1;
      if (this.inXR) this.xr.pulse('both', 0.5, 60);
      return;
    }
    if (step.at === 'bottom') {
      p.x = L.x + L.nx * 0.3;
      p.z = L.z + L.nz * 0.3;
      p.y = L.bottomY;
      p.heading = Math.atan2(L.nx, L.nz); // facing away from the ladder
      this.climb = null;
      this.climbCooldown = 1;
      return;
    }
    p.x = L.x;
    p.z = L.z;
    p.y = st.y;
    p.heading = Math.atan2(-L.nx, -L.nz);
    if (step.rung) {
      if (this.inXR) this.xr.pulse('both', 0.25, 25);
      this.onPlayerEvent({ type: 'step', value: 0.25, x: p.x, z: p.z });
    }
  }

  private updateLift(dt: number) {
    const L = this.lift!;
    L.t += dt / 9;
    const p = this.player;
    const by = surfaceY(LIFT.base.x, LIFT.base.z, 0);
    const ty = surfaceY(LIFT.top.x, LIFT.top.z, 0);
    const u = L.dir === 'up' ? L.t : 1 - L.t;
    let x: number;
    let y: number;
    let z: number;
    if (u < 0.45) {
      const k = u / 0.45;
      x = LIFT.base.x;
      z = LIFT.base.z;
      y = by + (ty + 6 - by) * (k * k * (3 - 2 * k));
    } else if (u < 0.85) {
      const k = (u - 0.45) / 0.4;
      const s = k * k * (3 - 2 * k);
      x = LIFT.base.x + (LIFT.top.x - LIFT.base.x) * s;
      z = LIFT.base.z + (LIFT.top.z - LIFT.base.z) * s;
      y = ty + 6;
    } else {
      const k = (u - 0.85) / 0.15;
      x = LIFT.top.x;
      z = LIFT.top.z;
      y = ty + 6 - 6 * k;
    }
    const dx = x - p.x;
    const dz = z - p.z;
    p.x = x;
    p.y = y + 0.15;
    p.z = z;
    p.vx = dx / dt;
    p.vz = dz / dt;
    p.vy = 0;
    this.village.liftCabin.position.set(x, y, z);
    if (L.t >= 1) {
      const end = L.dir === 'up' ? LIFT.top : LIFT.base;
      const away = L.dir === 'up' ? Math.atan2(MESA.x - end.x, MESA.z - end.z) : Math.atan2(end.x - MESA.x, end.z - MESA.z);
      p.place(end.x + Math.sin(away) * 7, end.z + Math.cos(away) * 7, away);
      this.lift = null;
      this.liftCooldown = 4;
      if (this.inXR) this.rig.position.set(p.x, p.y, p.z);
    }
  }

  // ------------------------------------------------------------------ visuals
  private updatePlayerVisuals(dt: number) {
    const p = this.player;
    const xr = this.inXR;
    const water = surfaceY(p.x, p.z, this.time);
    const facing = p.riding ? p.heading : p.speed > 0.5 ? Math.atan2(p.vx, p.vz) : p.heading;

    if (!xr) {
      const runAmount = p.mode === 'foot' ? clamp(Math.hypot(p.vx - (p.platform?.vx ?? 0), p.vz - (p.platform?.vz ?? 0)) / 7, 0, 1) : 0;
      this.avatar.root.userData.ph = ((this.avatar.root.userData.ph as number) ?? 0) + dt * (4 + runAmount * 9) * (runAmount > 0.05 ? 1 : 0);
      const pose = {
        mode: p.mode,
        crouch: p.crouch,
        lean: clamp(this.desk.keys.has('KeyA') ? -1 : this.desk.keys.has('KeyD') ? 1 : 0, -1, 1) * (p.riding ? 1 : 0),
        runPhase: this.avatar.root.userData.ph as number,
        runAmount,
        boardYaw: p.boardYaw,
        armsOut: p.gliding ? 1 : 0,
        wave: 0,
        talk: 0,
        time: this.time,
      } as const;
      for (const av of [this.avatar, this.avatarMirror]) {
        poseAvatar(av, pose);
        const carry = p.mode === 'foot' && p.hasBoard;
        av.board.visible = p.riding || carry;
        if (carry) {
          av.board.position.set(0.32, 0.9, 0);
          av.board.rotation.set(0, 0, Math.PI / 2);
        }
      }
      this.avatar.root.position.set(p.x, p.y, p.z);
      this.avatar.root.rotation.y = facing;
      const m = this.avatarMirror.root;
      m.position.set(p.x, 2 * water - p.y, p.z);
      m.rotation.set(-this.avatar.root.rotation.x, facing, -this.avatar.root.rotation.z);
      m.scale.set(1, -1, 1);
    }

    // VR: board under your feet, carried board in your right hand
    this.vrBoard.visible = xr && p.riding;
    this.vrBoardMirror.visible = this.vrBoard.visible;
    this.vrCarry.visible = xr && p.mode === 'foot' && p.hasBoard;
    if (this.vrBoard.visible) {
      this.vrBoard.position.set(p.x, p.y + 0.01, p.z);
      this.vrBoard.rotation.set(0, p.heading + p.boardYaw, 0);
      this.vrBoardMirror.position.set(p.x, 2 * water - p.y - 0.02, p.z);
      this.vrBoardMirror.rotation.copy(this.vrBoard.rotation);
      this.vrBoardMirror.scale.set(1, -1, 1);
    }

    // thrown board
    const b = p.board;
    this.thrownBoard.visible = b.active;
    this.thrownMirror.visible = b.active;
    if (b.active) {
      this.thrownBoard.position.set(b.x, b.y, b.z);
      this.thrownBoard.rotation.set(0, b.heading, 0);
      const bw = surfaceY(b.x, b.z, this.time);
      this.thrownMirror.position.set(b.x, 2 * bw - b.y, b.z);
      this.thrownMirror.rotation.copy(this.thrownBoard.rotation);
      this.thrownMirror.scale.set(1, -1, 1);
    }

    // sail: stands on the board, its normal at the trimmed angle
    this.sail.visible = p.sailOut && (p.riding || p.mode === 'foot');
    if (this.sail.visible) {
      const f = new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading));
      this.sail.position.set(p.x + f.x * 0.35, p.y, p.z + f.z * 0.35);
      this.sail.rotation.set(0, p.sailAngle, -p.sailEff * 0.15);
      const cloth = this.sail.getObjectByName('sailcloth') as THREE.Mesh;
      cloth.scale.z = 1;
      if (xr) this.sail.scale.setScalar(0.9);
    }
    // wing over your shoulders
    this.wing.visible = p.gliding;
    if (p.gliding) {
      const top = xr ? this.headInfo().pos.clone().add(new THREE.Vector3(0, 0.45, 0)) : new THREE.Vector3(p.x, p.y + 2.0, p.z);
      this.wing.position.copy(top);
      this.wing.rotation.set(clamp(p.vy * 0.03, -0.4, 0.4), p.heading, 0);
    }

    // spray + wake
    if (p.mode === 'board' && p.speed > 1) {
      const fx = Math.sin(p.heading);
      const fz = Math.cos(p.heading);
      const sp = p.speed;
      const n = Math.floor(p.skid * sp * 0.9 + (sp > 9 ? 1 : 0));
      if (n > 0) {
        this.spray.emit(p.x - fx * 0.5, p.y + 0.05, p.z - fz * 0.5, -fx * sp * 0.25 + p.vx * 0.3, 1.5 + p.skid * 3, -fz * sp * 0.25 + p.vz * 0.3, n, 1.5 + p.skid * 2, 0.08, 0.9);
      }
      // carve spray: a sheet of water thrown off the outside rail
      const carve = Math.abs(p.carve);
      if (carve > 0.5 && sp > 4) {
        const out = -Math.sign(p.carve); // outside of the turn
        const rx = -Math.cos(p.heading) * out;
        const rz = Math.sin(p.heading) * out;
        const k = Math.floor(carve * sp * 0.35 * (0.6 + p.crouch));
        this.spray.emit(p.x + rx * 0.3 - fx * 0.2, p.y + 0.05, p.z + rz * 0.3 - fz * 0.2, rx * sp * 0.45 + p.vx * 0.55, 1.2 + carve * 1.3, rz * sp * 0.45 + p.vz * 0.55, k, 1.2, 0.075, 0.8);
      }
      if (p.depth > 0.3) this.spray.emit(p.x + fx * 0.6, p.y + 0.05, p.z + fz * 0.6, fx * 1.5, 0.8, fz * 1.5, 1, 1, 0.07, 0.6);
    }
    this.wake.push(p.x, water, p.z, p.heading, p.mode === 'board' ? clamp(p.speed / 10, 0.2, 1) : 0, this.time);
    this.wake.update(this.time);
  }

  private updateCamera(dt: number) {
    const p = this.player;
    const sp = p.speed;
    if (p.riding || sp > 1.2) this.camYaw += wrapAngle(p.heading - this.camYaw) * Math.min(1, dt * (p.riding ? 2.2 : 1.4));
    const yaw = this.camYaw + Math.PI + this.desk.orbitYaw;
    const dist = 5.2 + Math.min(sp, 25) * 0.16 + (p.gliding ? 5 : 0) + (this.dialog.open ? -1.5 : 0);
    const pitch = this.desk.orbitPitch + (p.gliding ? 0.12 : 0);
    const target = new THREE.Vector3(p.x, p.y + 1.25, p.z);
    const desired = new THREE.Vector3(
      target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      target.y + Math.sin(pitch) * dist + 0.5,
      target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    desired.y = Math.max(desired.y, surfaceY(desired.x, desired.z, this.time) + 0.5);
    const k = 1 - Math.exp(-dt * 7);
    this.camera.position.lerp(desired, k);
    if (p.riding && sp > 9) {
      const s = (sp - 9) * 0.0025;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }
    const look = target.clone().add(new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw)).multiplyScalar(2.5));
    this.camera.lookAt(look);
    const fov = 64 + Math.min(sp, 28) * 0.75;
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();
  }

  private updateFeedback(dt: number) {
    const p = this.player;
    const xr = this.inXR;
    const head = xr ? this.headInfo() : undefined;
    if (head) {
      this.hud.updateVR(dt, head);
      this.dialog.place(head.pos);
      const yawRate = Math.abs(wrapAngle(this.rig.rotation.y - this.lastRigYaw)) / Math.max(dt, 1e-3);
      const accel = Math.abs(p.speed - this.lastSpeed) / Math.max(dt, 1e-3);
      const want = clamp((yawRate - 0.35) * 0.35 + Math.max(0, accel - 6) * 0.03 + (p.mode === 'wipeout' ? 0.8 : 0), 0, 0.8);
      this.vigAmt += (want - this.vigAmt) * Math.min(1, dt * (want > this.vigAmt ? 8 : 2.5));
      this.vignette.material.uniforms.uAmt.value = this.vigAmt;
      this.vignette.visible = this.vigAmt > 0.02;
    } else this.vignette.visible = false;
    this.lastRigYaw = this.rig.rotation.y;
    this.lastSpeed = p.speed;
    // continuous haptics: the film buzzing under the board
    this.hapticT -= dt;
    if (xr && this.hapticT <= 0) {
      this.hapticT = 0.09;
      if (p.mode === 'board') this.xr.pulse('both', clamp(0.03 + p.speed * 0.01 + p.skid * 0.35 + Math.abs(p.carve) * 0.08, 0, 0.6), 70);
    }
    // nearest villager hint
    let hint = '';
    const near = this.villagers.nearest(this.playerPos(), 7);
    if (this.dialog.open) hint = xr ? 'Hold A and talk · point + trigger to reply · B to leave' : 'Type to talk · Esc / T to leave';
    else if (near) hint = `${xr ? 'B' : 'T'} — talk to ${near.p.name.replace(/".*?" /, '')}`;
    else if (p.mode === 'foot' && p.hasBoard && p.speed < 4) hint = xr ? 'Swing your arms to run, then trigger to throw the board' : 'Hold W to run, then E to throw your board';
    else if (p.board.active && p.board.loose) hint = xr ? 'Trigger again just before you land: kick it forward!' : 'E again just before you land: kick it forward!';
    else if (p.board.active && p.board.moving) hint = xr ? 'Hop (A or really jump) just before you reach it!' : 'SPACE just before you reach the board!';
    else if (p.mode === 'board' && this.time < 200) hint = xr ? 'Crouch over crests, stand into dips · lean to carve' : 'Shift: crouch over crests, release into dips · A/D carve · Space ollie';
    else if (p.mode === 'board' && !p.hasSail) {
      const w = windAt(p.x, p.z, this.time);
      if (Math.hypot(w.x, w.z) > 9) hint = "Big wind — grab a sail at June's Sail Loft";
    }
    if (p.sailOut) hint = xr ? 'Aim the sail with your left hand' : 'Sail up — Z / X to trim';
    if (p.mode === 'air' && p.hasWing && !p.gliding) hint = xr ? 'Spread your arms to glide' : 'Hold G to glide';

    const w = regionWeights(p.x, p.z);
    this.hud.update(
      {
        speed: p.speed,
        flow: p.flow,
        mode: this.lift ? 'Mist Lift' : this.climb ? 'climbing' : p.mode === 'board' ? (p.depth > 0.3 ? 'planing · deep' : 'planing') : p.mode === 'air' ? (p.gliding ? 'gliding' : 'air') : p.mode === 'wipeout' ? 'wipeout' : p.platform ? (this.decks.has(p.platform.id) ? 'on the deck' : 'aboard') : p.hasBoard ? 'on foot' : 'board thrown',
        pump: p.mode === 'board' ? p.pumpA : 0,
        sailEff: p.sailOut ? p.sailEff : null,
        hour: this.hour,
        day: this.day,
        region: this.region ? REGIONS.find((r) => r.id === this.region)!.name : 'the open film',
        hint,
        ai: `${this.aiText} · ${Math.round(this.fps)} fps`,
      },
      xr,
    );

    const surf = Math.max(0, 1 - Math.abs(p.z - 980) / 160) * Math.max(0, 1 - Math.abs(p.x + 250) / 600);
    let fallsNear = 0;
    for (const s of this.falls.spots) fallsNear = Math.max(fallsNear, 1 - Math.hypot(s.x - p.x, s.z - p.z) / 120);
    this.audio.update(dt, {
      speed: p.mode === 'air' ? Math.hypot(p.vx, p.vy, p.vz) : p.speed,
      riding: p.riding,
      airborne: p.mode === 'air',
      skid: Math.min(1, p.skid + Math.abs(p.carve) * 0.25),
      flow: p.flow,
      depth: p.depth,
      surfNear: surf,
      fallsNear,
      region: this.region ?? 'tidewell',
      glow: w.glowmarsh,
    });
  }
}
