// Input: desktop (keyboard + mouse) and Quest (head + controllers).
//
// Quest mapping — your body is the controller:
//   swing your arms to run           left stick also moves
//   right trigger    throw board (or mid-hop: toss it under you) / hop off a fast board,
//                    then again late in the hop to kick it forward / pick up
//   A  (or really hop)               jump / ollie — crouch first to charge
//   crouch & stand                   pump the rollers
//   lean your head/body left/right   carve (left stick X assists)
//   X                                sail up/down; aim the sail with your left hand
//   both grips + arms out            glide wing (raise/lower hands to pitch)
//   right stick X                    snap turn on foot / spin in the air
//   B                                talk to the nearest villager
//   A (held, while talking)          say anything: push-to-talk

import * as THREE from 'three';
import { clamp } from '../../shared/noise';

export interface Actions {
  jump: boolean;
  drop: boolean;
  sail: boolean;
  talk: boolean;
  respawn: boolean;
  teleport: number; // 1..5, 0 none
  timeShift: number;
  help: boolean;
  mute: boolean;
  select: boolean; // UI click (XR trigger while pointing at a panel)
}

export interface Continuous {
  moveX: number;
  moveY: number;
  run: number;
  leanAssist: number;
  crouch: number;
  spin: number;
  sailTrimOffset: number;
  wing: boolean;
  pitch: number;
  snapTurn: number;
  sailWorldYaw: number | null; // XR: where the left hand points the sail
  climbStick: number; // XR: left stick up/down (-1..1), used on ladders instead of arm-swing running
  climbPull: number; // XR: metres a gripped hand was pulled down this frame (hand-over-hand climbing)
  talkHold: boolean; // XR: A held (push-to-talk while chatting with a villager)
}

const emptyActions = (): Actions => ({
  jump: false,
  drop: false,
  sail: false,
  talk: false,
  respawn: false,
  teleport: 0,
  timeShift: 0,
  help: false,
  mute: false,
  select: false,
});

export class DesktopInput {
  keys = new Set<string>();
  private pressed = new Set<string>();
  orbitYaw = 0;
  orbitPitch = 0.22;
  private crouch = 0;
  private trim = 0;
  enabled = true;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    let dragging = false;
    let lx = 0;
    let ly = 0;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
    });
    window.addEventListener('pointerup', () => (dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.orbitYaw -= (e.clientX - lx) * 0.005;
      this.orbitPitch = clamp(this.orbitPitch + (e.clientY - ly) * 0.004, -0.1, 1.2);
      lx = e.clientX;
      ly = e.clientY;
    });
  }

  private down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  read(dt: number, airborne: boolean): { actions: Actions; cont: Continuous } {
    const a = emptyActions();
    const p = this.pressed;
    a.jump = p.has('Space');
    a.drop = p.has('KeyE');
    a.sail = p.has('KeyF');
    a.talk = p.has('KeyT');
    a.respawn = p.has('KeyR');
    a.help = p.has('KeyH');
    a.mute = p.has('KeyM');
    for (let i = 1; i <= 5; i++) if (p.has(`Digit${i}`)) a.teleport = i;
    if (p.has('BracketLeft')) a.timeShift = -1;
    if (p.has('BracketRight')) a.timeShift = 1;
    p.clear();

    const fwd = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    const side = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    const wantCrouch = this.down('ShiftLeft', 'ShiftRight', 'KeyC') ? 1 : 0;
    this.crouch += clamp(wantCrouch - this.crouch, -dt * 3.2, dt * 3.2);
    if (this.down('KeyZ', 'KeyQ')) this.trim -= dt * 1.2;
    if (this.down('KeyX')) this.trim += dt * 1.2;
    this.trim = clamp(this.trim, -1.2, 1.2);
    const spin = (this.down('ArrowRight') ? 1 : 0) - (this.down('ArrowLeft') ? 1 : 0);
    return {
      actions: a,
      cont: {
        moveX: side,
        moveY: fwd,
        run: fwd > 0 ? 1 : 0.4,
        leanAssist: side,
        crouch: this.crouch,
        spin: airborne ? spin || 0 : 0,
        sailTrimOffset: this.trim,
        wing: this.down('KeyG'),
        pitch: fwd * -1,
        snapTurn: 0,
        sailWorldYaw: null,
        climbStick: 0,
        climbPull: 0,
        talkHold: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------

interface Hand {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vy: number;
  yaw: number;
  gamepad: Gamepad | null;
  buttons: boolean[];
  grip: THREE.XRGripSpace;
  ray: THREE.XRTargetRaySpace;
}

export class XRInput {
  hands: { left: Hand; right: Hand };
  standH = 1.6;
  headLocal = new THREE.Vector3();
  headWorld = new THREE.Vector3();
  headYaw = 0;
  private headPrevY = 1.6;
  private headVy = 0;
  private swing = 0;
  private snapReady = true;
  private lastHop = 0;

  constructor(private renderer: THREE.WebGLRenderer, rig: THREE.Group) {
    const mk = (i: number): Hand => {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      rig.add(ray, grip);
      return { pos: new THREE.Vector3(), prev: new THREE.Vector3(), vy: 0, yaw: 0, gamepad: null, buttons: [], grip, ray };
    };
    const h0 = mk(0);
    const h1 = mk(1);
    this.hands = { left: h0, right: h1 };
    for (const [ctrl, idx] of [
      [h0, 0],
      [h1, 1],
    ] as const) {
      ctrl.ray.addEventListener('connected', (e) => {
        const src = e.data;
        if (!src) return;
        if (src.handedness === 'left') this.hands.left = ctrl;
        if (src.handedness === 'right') this.hands.right = ctrl;
        ctrl.gamepad = src.gamepad ?? null;
        void idx;
      });
    }
  }

  pulse(hand: 'left' | 'right' | 'both', intensity: number, ms: number) {
    const hs = hand === 'both' ? [this.hands.left, this.hands.right] : [this.hands[hand]];
    for (const h of hs) {
      const act = (h.gamepad as Gamepad & { hapticActuators?: Array<{ pulse: (i: number, d: number) => void }> })?.hapticActuators?.[0];
      try {
        act?.pulse(clamp(intensity, 0, 1), ms);
      } catch {
        /* not supported */
      }
    }
  }

  read(dt: number, camera: THREE.Camera, airborne: boolean, onFoot: boolean): { actions: Actions; cont: Continuous } {
    const a = emptyActions();
    // three.js copies the head pose onto the user camera (a child of the rig)
    this.headLocal.copy(camera.position);
    camera.getWorldPosition(this.headWorld);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    this.headYaw = Math.atan2(dir.x, dir.z);

    const hy = this.headLocal.y;
    this.headVy = (hy - this.headPrevY) / Math.max(dt, 1e-3);
    this.headPrevY = hy;
    if (hy > this.standH) this.standH = hy;
    else this.standH -= dt * 0.004;
    const crouch = clamp((this.standH - hy - 0.04) / 0.35, 0, 1);

    const edges = (h: Hand) => {
      const gp = h.gamepad;
      const now = gp ? gp.buttons.map((b) => b.pressed) : [];
      const e = now.map((v, i) => v && !h.buttons[i]);
      h.buttons = now;
      return { now, e };
    };
    const L = edges(this.hands.left);
    const R = edges(this.hands.right);
    a.drop = !!R.e[0];
    a.select = !!R.e[0];
    a.jump = !!R.e[4];
    a.talk = !!R.e[5];
    a.sail = !!L.e[4];
    a.help = !!L.e[5];

    // real hop: fast upward head motion
    if (this.headVy > 1.1 && performance.now() - this.lastHop > 600) {
      a.jump = true;
      this.lastHop = performance.now();
    }

    // arm swing
    for (const h of [this.hands.left, this.hands.right]) {
      h.prev.copy(h.pos);
      h.pos.copy(h.grip.position);
      h.vy = (h.pos.y - h.prev.y) / Math.max(dt, 1e-3);
      const q = h.ray.quaternion;
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      h.yaw = Math.atan2(f.x, f.z);
    }
    // hand-over-hand: a hand that kept grip squeezed since last frame drags the body by its motion
    let pull = 0;
    let pulling = 0;
    for (const [h, st] of [
      [this.hands.left, L],
      [this.hands.right, R],
    ] as const) {
      if (st.now[1] && !st.e[1]) {
        pull += h.prev.y - h.pos.y;
        pulling++;
      }
    }
    const sw = (Math.abs(this.hands.left.vy) + Math.abs(this.hands.right.vy)) / 2;
    this.swing += (sw - this.swing) * Math.min(1, dt * 6);
    const swingRun = clamp((this.swing - 0.35) / 1.6, 0, 1);

    const ls = this.hands.left.gamepad?.axes ?? [];
    const rs = this.hands.right.gamepad?.axes ?? [];
    const lx = ls[2] ?? 0;
    const ly = ls[3] ?? 0;
    const rx = rs[2] ?? 0;
    let snap = 0;
    if (onFoot) {
      if (Math.abs(rx) > 0.7 && this.snapReady) {
        snap = Math.sign(rx);
        this.snapReady = false;
      }
      if (Math.abs(rx) < 0.3) this.snapReady = true;
    }
    const stickRun = Math.max(0, -ly);
    const moveY = Math.max(swingRun > 0.05 ? 1 : 0, -ly);
    const grips = !!L.now[1] && !!R.now[1];
    const spread = this.hands.left.grip.position.distanceTo(this.hands.right.grip.position);
    const avgHandY = (this.hands.left.grip.position.y + this.hands.right.grip.position.y) / 2;
    const rigYaw = (this.hands.left.grip.parent as THREE.Object3D | null)?.rotation.y ?? 0;

    return {
      actions: a,
      cont: {
        moveX: Math.abs(lx) > 0.2 ? lx : 0,
        moveY: Math.abs(moveY) > 0.15 ? moveY : 0,
        run: Math.max(swingRun, stickRun > 0.9 ? 0.75 : stickRun * 0.6),
        leanAssist: Math.abs(lx) > 0.2 ? lx : 0,
        crouch,
        spin: airborne ? rx : 0,
        sailTrimOffset: 0,
        wing: grips || spread > 1.25,
        pitch: clamp((avgHandY - (hy - 0.35)) / 0.3, -1, 1),
        snapTurn: snap,
        sailWorldYaw: this.hands.left.gamepad ? this.hands.left.yaw + rigYaw + Math.PI / 2 : null,
        climbStick: Math.abs(ly) > 0.2 ? -ly : 0,
        climbPull: pulling ? pull / pulling : 0,
        talkHold: !!R.now[4],
      },
    };
  }
}
