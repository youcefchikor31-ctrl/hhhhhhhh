import { Vector3, MathUtils } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Ground } from '../world/Ground.js';
import { DustMotes } from '../world/DustMotes.js';
import { ContactShadows } from '../world/ContactShadows.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';

import { settings, ELEMENTS } from '../config/settings.js';

/*
 * Keep asset paths relative to Vite's configured base URL.
 *
 * This works both:
 *   - locally: http://localhost:5173/
 *   - GitHub Pages: /hhhhhhhh/
 */
const BASE_URL = import.meta.env.BASE_URL || './';

const assetPath = (path) => {
  const cleanPath = String(path).replace(/^\/+/, '');
  const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;

  return new URL(cleanPath, new URL(base, window.location.href)).href;
};

const HDR_URL = assetPath('hdri/spruit_sunrise.hdr');

/**
 * Application root: owns every subsystem and the frame loop.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /**
     * Seconds left before each ability can be armed again.
     */
    this.cooldowns = new Map(
      ELEMENTS.map((element) => [element, 0])
    );

    /* ---- core ---- */

    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.environment = new Environment(
      this.renderer,
      this.camera
    );

    this.scene = this.environment.scene;

    /* ---- world ---- */

    this.ground = new Ground(this.environment);
    this.dust = new DustMotes();

    this.contactShadows = new ContactShadows(
      this.renderer,
      {
        size: 2.6,
        height: 2.4,
        blur: 2.0
      }
    );

    this.scene.add(
      this.ground.mesh,
      this.dust.points,
      this.contactShadows.group
    );

    this.dust.setPixelRatio(
      this.renderer.gl.getPixelRatio()
    );

    /* ---- shared VFX services ---- */

    this.particles = new ParticleEngine(this.scene);
    this.lights = new LightPool(this.scene);
    this.decals = new DecalSystem(this.scene);
    this.fissures = new FissureSystem(this.scene);
    this.bursts = new BurstSystem(this.scene);

    this.shake = new CameraShake(this.rig);
    this.flash = new ScreenFlash();

    this.abilities = new AbilityManager({
      scene: this.scene,
      camera: this.camera,
      environment: this.environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash
    });

    /* ---- character ---- */

    this.character = new CharacterController(
      this.environment
    );

    this.scene.add(this.character.root);

    /* ---- input & targeting ---- */

    this.input = new InputManager(canvas);
    this.aim = new AimController(this.camera);

    this.scene.add(this.aim.object3D);

    /* ---- post ---- */

    this.post = new PostProcessing(
      this.renderer,
      this.scene,
      this.camera
    );

    /* ---- UI ---- */

    this.loading = new LoadingScreen();

    this.hud = new HUD(
      document.getElementById('hud')
    );

    this.editor = new Editor({
      onClear: () => this.clearEffects(),
      onToast: (message) =>
        this.hud.showToast(message)
    });

    this._bindEvents();

    this.selectAbility(
      ELEMENTS[0],
      { silent: true }
    );

    this._focusPoint = new Vector3();
  }

  get element() {
    return this.abilities.selected;
  }

  _bindEvents() {
    this.renderer.onResize(
      (width, height, pixelRatio) => {
        this.rig.resize(
          width,
          height
        );

        this.post.setSize(
          width,
          height,
          pixelRatio
        );

        this.dust.setPixelRatio(
          pixelRatio
        );
      }
    );

    this.input.on(
      'pointer:move',
      (pointer) => this.aim.point(pointer)
    );

    this.input.on(
      'pointer:confirm',
      (pointer) => {
        this.aim.point(pointer);
        this.aim.confirm();
      }
    );

    this.input.on(
      'action',
      (action, slot) =>
        this._handleAction(action, slot)
    );

    this.aim.on(
      'cast',
      (origin, direction, distance) =>
        this._cast(
          origin,
          direction,
          distance
        )
    );

    this.aim.on(
      'reject',
      () =>
        this.hud.showToast(
          'Too close — aim further out'
        )
    );

    this.hud.onAbility = (element) =>
      this.armAbility(element);
  }

  _handleAction(action, slot) {
    switch (action) {
      case 'ability': {
        const element =
          ELEMENTS[slot] ?? this.element;

        if (
          this.aim.isArmed &&
          element === this.element
        ) {
          this.aim.cancel();
        } else {
          this.armAbility(element);
        }

        break;
      }

      case 'cancel':
        this.aim.cancel();
        break;

      case 'toggleHelp':
        this.hud.toggleHelp();
        break;

      case 'toggleEditor':
        this.editor.toggle();
        break;

      case 'clear':
        this.clearEffects();
        this.hud.showToast(
          'Effects cleared'
        );
        break;

      case 'togglePause':
        this.paused = !this.paused;

        this.hud.setPaused(
          this.paused
        );

        this.hud.showToast(
          this.paused
            ? 'Paused — the editor still applies'
            : 'Resumed'
        );

        break;

      default:
        break;
    }
  }

  selectAbility(
    element,
    options = {}
  ) {
    if (!ELEMENTS.includes(element)) {
      return;
    }

    this.abilities.select(element);
    this.aim.setElement(element);
    this.hud.setElement(
      element,
      options
    );
  }

  armAbility(
    element = this.element
  ) {
    if (
      (this.cooldowns.get(element) ?? 0) > 0
    ) {
      this.hud.showToast(
        'Not ready'
      );

      return;
    }

    if (
      element !== this.element
    ) {
      this.selectAbility(element);
    }

    this.aim.arm();
  }

  _cast(
    origin,
    direction,
    distance
  ) {
    const element = this.element;

    this.abilities.cast(
      origin,
      direction,
      distance,
      element
    );

    this.cooldowns.set(
      element,
      Math.max(
        0,
        settings[element].cooldown
      )
    );

    this.character.setFacing(
      this.aim.facing
    );

    this.character.playCast(
      settings[element].castAnim
    );

    this.character.castLunge();
  }

  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    this.particles.reset();
    this.decals.clear();
    this.fissures.clear();
    this.bursts.clear();
    this.lights.reset();
    this.shake.reset();
    this.flash.reset();
  }

  /**
   * Load the application.
   *
   * HDR is deliberately optional.
   *
   * If it fails or times out, the application continues using
   * AmbientLight / HemisphereLight / DirectionalLight from
   * Environment.js.
   */
  async load() {
    const assets = new AssetLoader();

    /*
     * ---------------------------------------------------------
     * HDR
     * ---------------------------------------------------------
     *
     * Do NOT allow the HDR to block the entire application.
     */

    this.loading.setProgress(
      0.05,
      'Loading environment…'
    );

    try {
      const hdr = await assets.loadHDR(
        HDR_URL,
        {
          timeout: 10000
        }
      );

      if (hdr) {
        try {
          await this.environment.loadEnvironment(
            hdr
          );

          frame.uEnvMap.value =
            this.environment.equirect;

          console.info(
            '[App] HDR environment loaded.'
          );
        } catch (error) {
          console.warn(
            '[App] HDR environment setup failed. Continuing without HDR.',
            error
          );

          frame.uEnvMap.value = null;

          hdr.dispose?.();
        }
      } else {
        console.warn(
          '[App] HDR unavailable. Continuing with scene lighting.'
        );

        frame.uEnvMap.value = null;
      }
    } catch (error) {
      /*
       * HDR must NEVER prevent the application
       * from starting.
       */
      console.warn(
        '[App] HDR loading failed. Continuing without HDR.',
        error
      );

      frame.uEnvMap.value = null;
    }

    /*
     * ---------------------------------------------------------
     * FLOOR
     * ---------------------------------------------------------
     */

    this.loading.setProgress(
      0.35,
      'Loading floor…'
    );

    await this.ground.loadTextures(
      assets
    );

    /*
     * ---------------------------------------------------------
     * CHARACTER
     * ---------------------------------------------------------
     */

    this.loading.setProgress(
      0.5,
      'Loading character…'
    );

    await this.character.load(
      assets
    );

    /*
     * ---------------------------------------------------------
     * SHADERS
     * ---------------------------------------------------------
     */

    this.loading.setProgress(
      0.85,
      'Compiling shaders…'
    );

    /*
     * compileAsync exists on modern WebGLRenderer.
     *
     * Keep a fallback for browsers where it is
     * unavailable.
     */

    if (
      typeof this.renderer.gl.compileAsync ===
      'function'
    ) {
      await this.renderer.gl.compileAsync(
        this.scene,
        this.camera
      );
    } else {
      this.renderer.gl.compile(
        this.scene,
        this.camera
      );
    }

    /*
     * ---------------------------------------------------------
     * READY
     * ---------------------------------------------------------
     */

    this.loading.setProgress(
      1,
      'Ready'
    );

    this.loading.hide();

    this.start();
  }

  start() {
    this.time.reset();

    const loop = () => {
      this._raf =
        requestAnimationFrame(loop);

      this.frame();
    };

    this._raf =
      requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(
      this._raf
    );
  }

  frame() {
    const gl =
      this.renderer.gl;

    gl.info.reset();

    const raw =
      this.time.tick();

    const dt =
      this.paused
        ? 0
        : raw *
          settings.global.timeScale;

    this.elapsed += dt;

    /*
     * Shared uniforms
     */

    frame.uTime.value =
      this.elapsed;

    frame.uDelta.value =
      dt;

    frame.uShaderIntensity.value =
      settings.global.shaderIntensity;

    frame.uGlobalGlow.value =
      settings.global.glow;

    frame.uCameraNear.value =
      this.camera.near;

    frame.uCameraFar.value =
      this.camera.far;

    /*
     * Renderer
     */

    this.renderer.syncSettings();

    /*
     * Environment
     */

    this.environment.setFocus(
      this.character.position.x,
      this.character.position.z
    );

    this.environment.update();

    /*
     * Targeting
     */

    this.aim.setOrigin(
      this.character.position
    );

    this.aim.update(raw);

    if (
      settings.character.turnToAim &&
      this.aim.isArmed
    ) {
      this.character.turnToward(
        this.aim.facing,
        settings.character.turnRate,
        raw
      );
    }

    /*
     * Character
     */

    this.character.update(dt);

    /*
     * Cooldowns
     */

    for (
      const [
        element,
        remaining
      ] of this.cooldowns
    ) {
      if (remaining > 0) {
        this.cooldowns.set(
          element,
          Math.max(
            0,
            remaining - raw
          )
        );
      }
    }

    /*
     * World
     */

    this.ground.update(
      this.elapsed
    );

    this.dust.update(
      this.elapsed,
      this.character.position
    );

    /*
     * Effects
     */

    this.abilities.update(dt);
    this.particles.flush();
    this.decals.update(dt);
    this.fissures.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);

    /*
     * Camera
     */

    const focus =
      this.abilities.focus;

    if (focus) {
      this.rig.lookAt(
        focus.position,
        MathUtils.clamp(
          1 - focus.u * 0.4,
          0,
          1
        )
      );
    }

    this.rig.setAnchor(
      this.character.position.x,
      0,
      this.character.position.z
    );

    this.shake.update(raw);
    this.flash.update(raw);
    this.rig.update(raw);

    /*
     * Contact shadows
     */

    this.contactShadows.setPosition(
      this.character.position.x,
      this.character.position.z
    );

    this.contactShadows.render(
      this.scene
    );

    /*
     * Render
     */

    gl.shadowMap.needsUpdate = true;

    this.post.sync(
      this.elapsed,
      this.flash
    );

    this.post.render();

    /*
     * HUD
     */

    for (
      const element of ELEMENTS
    ) {
      this.hud.setCooldown(
        element,
        this.cooldowns.get(element) ?? 0,
        settings[element].cooldown
      );
    }

    this.hud.setArmed(
      this.aim.isArmed
    );

    this.hud.update(
      raw,
      () => ({
        particles:
          this.particles.countLive(
            this.elapsed
          ),

        calls:
          gl.info.render.calls,

        spikes:
          this.abilities.active.reduce(
            (
              total,
              ability
            ) =>
              total +
              ability.instanceCount,
            0
          ),

        abilities:
          this.abilities.active.length
      })
    );
  }

  dispose() {
    this.stop();

    this.input.dispose();
    this.aim.dispose();

    this.abilities.dispose();

    this.particles.dispose();
    this.decals.dispose();
    this.fissures.dispose();
    this.bursts.dispose();
    this.lights.dispose();

    this.character.dispose();
    this.ground.dispose();
    this.dust.dispose();
    this.contactShadows.dispose();

    this.post.dispose();
    this.environment.dispose();
    this.editor.dispose();

    this.rig.dispose();
    this.renderer.dispose();
  }
}
