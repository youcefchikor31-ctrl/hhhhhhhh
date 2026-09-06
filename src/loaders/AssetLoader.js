import {
  LoadingManager,
  TextureLoader
} from 'three';

import { FBXLoader } from
  'three/addons/loaders/FBXLoader.js';

import { HDRLoader } from
  'three/addons/loaders/HDRLoader.js';

/**
 * A 1×1 opaque white PNG.
 *
 * Some FBX files can contain absolute local paths
 * such as:
 *
 * C:/Users/.../texture.png
 *
 * Those paths cannot work on a web server, so they
 * are redirected to a harmless placeholder.
 */
export const PLACEHOLDER_TEXTURE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

/**
 * Matches Windows drive paths and UNC paths.
 */
const ABSOLUTE_LOCAL_PATH =
  /(^|\/)[A-Za-z]:[\\/]|^\\\\/;

/**
 * Check whether a URL is already absolute.
 */
const ABSOLUTE_URL =
  /^(?:https?:|data:|blob:|file:)/i;

/**
 * Resolve a public asset against Vite's BASE_URL.
 *
 * Examples:
 *
 * Local:
 *   /models/Idle.fbx
 *
 * GitHub Pages:
 *   /hhhhhhhh/models/Idle.fbx
 */
function resolveAssetUrl(url) {
  if (!url) {
    return url;
  }

  const value =
    String(url).trim();

  /*
   * Absolute external/data URLs should
   * remain untouched.
   */
  if (
    ABSOLUTE_URL.test(value)
  ) {
    return value;
  }

  /*
   * Local filesystem paths are handled
   * by LoadingManager.setURLModifier().
   */
  if (
    ABSOLUTE_LOCAL_PATH.test(value)
  ) {
    return value;
  }

  const base =
    import.meta.env.BASE_URL || './';

  const normalizedBase =
    base.endsWith('/')
      ? base
      : `${base}/`;

  /*
   * Remove the leading slash so URL()
   * cannot escape the GitHub Pages
   * repository path.
   */
  const cleanPath =
    value.replace(/^\/+/, '');

  return new URL(
    cleanPath,
    new URL(
      normalizedBase,
      window.location.href
    )
  ).href;
}

/**
 * Central asset loading with one LoadingManager.
 */
export class AssetLoader {
  constructor() {
    this.manager =
      new LoadingManager();

    /*
     * Resolve URLs coming from:
     *
     * - JavaScript
     * - FBX internal texture references
     * - Three.js loaders
     *
     * This is especially important on
     * GitHub Pages because the project is
     * deployed under /hhhhhhhh/.
     */
    this.manager.setURLModifier(
      (url) => {
        /*
         * Broken absolute paths embedded
         * inside FBX files.
         */
        if (
          ABSOLUTE_LOCAL_PATH.test(url)
        ) {
          return PLACEHOLDER_TEXTURE_URL;
        }

        /*
         * data/blob/http URLs must not
         * receive the Vite base path.
         */
        if (
          ABSOLUTE_URL.test(url)
        ) {
          return url;
        }

        return resolveAssetUrl(url);
      }
    );

    this.fbx =
      new FBXLoader(
        this.manager
      );

    this.hdr =
      new HDRLoader(
        this.manager
      );

    this.texture =
      new TextureLoader(
        this.manager
      );

    this._onProgress = null;

    this._loaded = 0;
    this._total = 0;

    this._settleWaiters = [];

    /*
     * LoadingManager lifecycle.
     */

    this.manager.onStart = (
      url,
      loaded,
      total
    ) => {
      this._loaded =
        loaded;

      this._total =
        total;
    };

    this.manager.onProgress = (
      url,
      loaded,
      total
    ) => {
      this._loaded =
        loaded;

      this._total =
        total;

      this._onProgress?.(
        total
          ? loaded / total
          : 0,
        url
      );
    };

    this.manager.onLoad = () => {
      this._loaded =
        this._total;

      this._settleWaiters
        .splice(0)
        .forEach(
          (resolve) =>
            resolve()
        );
    };

    this.manager.onError = (
      url
    ) => {
      console.error(
        `[AssetLoader] failed: ${url}`
      );
    };
  }

  onProgress(callback) {
    this._onProgress =
      callback;
  }

  /**
   * Wait until all LoadingManager
   * requests have settled.
   *
   * A timeout is included so one broken
   * third-party asset cannot freeze the
   * whole application forever.
   */
  settled(timeout = 15000) {
    if (
      this._total === 0 ||
      this._loaded >= this._total
    ) {
      return Promise.resolve();
    }

    return new Promise(
      (resolve) => {
        let finished = false;

        const finish = () => {
          if (finished) {
            return;
          }

          finished = true;

          clearTimeout(timer);

          const index =
            this._settleWaiters.indexOf(
              finish
            );

          if (index !== -1) {
            this._settleWaiters.splice(
              index,
              1
            );
          }

          resolve();
        };

        const timer =
          setTimeout(
            () => {
              console.warn(
                '[AssetLoader] Waiting for assets timed out. Continuing.'
              );

              finish();
            },
            timeout
          );

        this._settleWaiters.push(
          finish
        );
      }
    );
  }

  /**
   * Load an FBX file.
   */
  loadFBX(url) {
    const resolved =
      resolveAssetUrl(url);

    return new Promise(
      (resolve, reject) => {
        this.fbx.load(
          resolved,

          resolve,

          (event) => {
            if (
              event.lengthComputable
            ) {
              this._onProgress?.(
                event.loaded /
                  event.total,
                resolved
              );
            }
          },

          reject
        );
      }
    );
  }

  /**
   * Load a regular texture.
   */
  loadTexture(url) {
    const resolved =
      resolveAssetUrl(url);

    return new Promise(
      (resolve, reject) => {
        this.texture.load(
          resolved,
          resolve,
          undefined,
          reject
        );
      }
    );
  }

  /**
   * Load HDR independently from the
   * LoadingManager.
   *
   * This is intentional.
   *
   * If the HDR server request hangs,
   * it must NOT leave LoadingManager
   * permanently waiting and prevent the
   * rest of the application from loading.
   *
   * The HDRLoader.parse() method parses
   * the downloaded ArrayBuffer directly.
   */
  async loadHDR(
    url,
    options = {}
  ) {
    const timeout =
      Number.isFinite(
        options.timeout
      )
        ? Math.max(
            1000,
            options.timeout
          )
        : 10000;

    const resolved =
      resolveAssetUrl(url);

    const controller =
      new AbortController();

    let timer = null;

    try {
      timer =
        setTimeout(
          () => {
            controller.abort();
          },
          timeout
        );

      const response =
        await fetch(
          resolved,
          {
            method: 'GET',
            cache: 'force-cache',
            signal:
              controller.signal
          }
        );

      if (
        !response.ok
      ) {
        throw new Error(
          `HDR request failed: HTTP ${response.status} ${response.statusText}`
        );
      }

      const buffer =
        await response.arrayBuffer();

      if (
        !buffer ||
        buffer.byteLength === 0
      ) {
        throw new Error(
          'HDR file is empty.'
        );
      }

      const texture =
        this.hdr.parse(buffer);

      if (!texture) {
        throw new Error(
          'HDRLoader.parse() returned no texture.'
        );
      }

      return texture;
    } catch (error) {
      if (
        error?.name ===
        'AbortError'
      ) {
        console.warn(
          `[AssetLoader] HDR loading timed out after ${timeout}ms: ${resolved}`
        );
      } else {
        console.warn(
          `[AssetLoader] HDR loading failed: ${resolved}`,
          error
        );
      }

      /*
       * Return null instead of rejecting.
       *
       * App.js treats HDR as optional.
       */
      return null;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
