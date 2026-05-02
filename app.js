/* ============================================================
   3D Splat Viewer — Application Logic  v1.0.0
   ============================================================
   • Loads Gaussian-Splat .ply / .splat / .ksplat files chosen
     by the user (file picker or drag-and-drop).
   • Renders them via @mkkellogg/gaussian-splats-3d (Three.js
     under the hood) with built-in orbit / pan / pinch controls.
   • Adds WASD + QE keyboard movement on top so the user can
     also fly the camera around the scene on a desktop.
   ============================================================ */

import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { OBJLoader }     from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ── Make sure no leftover service worker hijacks the page ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(names => names.forEach(n => caches.delete(n)));
}

/* ── DOM references ────────────────────────────────────────── */
const fileInput       = document.getElementById('fileInput');
const dropZone        = document.getElementById('dropZone');
const loadingEl       = document.getElementById('loading');
const loadingText     = document.getElementById('loadingText');
const topbar          = document.getElementById('topbar');
const sceneNameEl     = document.getElementById('sceneName');
const pointBtn        = document.getElementById('pointBtn');
const gridBtn         = document.getElementById('gridBtn');
const flipBtn         = document.getElementById('flipBtn');
const resetBtn        = document.getElementById('resetBtn');
const loadNewBtn      = document.getElementById('loadNewBtn');
const controlsEl      = document.getElementById('controls');
const controlsToggle  = document.getElementById('controlsToggle');
const controlsPanel   = document.getElementById('controlsPanel');

/* ── State ─────────────────────────────────────────────────── */
let viewer            = null;   // GaussianSplats3D.Viewer instance (splat mode)
let threeCtx          = null;   // {renderer, scene, camera, controls, raf} (mesh mode)
let currentObjectURL  = null;   // Object URL for the loaded blob
let initialCamPos     = null;   // for "Reset camera"
let initialCamTarget  = null;
let cameraUpYDown     = true;   // Y-down convention; toggled by "Flip up" (splat mode only)
let lastFile          = null;   // remember the last loaded file for re-loads
let helpers           = null;   // {grid, axes} — visible reference geometry
let fallbackPoints    = null;   // THREE.Points — splat centers, bypasses lib sort
let fallbackVisible   = true;   // toggled by the P button

function getActiveCamera()   { return viewer?.camera   ?? threeCtx?.camera   ?? null; }
function getActiveControls() { return viewer?.controls ?? threeCtx?.controls ?? null; }
function getActiveScene()    { return viewer?.threeScene ?? threeCtx?.scene ?? null; }

/* Build (or rebuild) a GridHelper + AxesHelper sized to the scene's
   bounding box and add them to whichever scene is active. Gives the
   user a visible reference even when splats themselves don't render. */
function buildHelpers(box) {
  removeHelpers();
  const scene = getActiveScene();
  if (!scene) return;

  let radius = 1;
  let center = new THREE.Vector3();
  if (box && !box.isEmpty()) {
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    radius = Math.max(size.length() * 0.5, 1);
  }

  // Grid sized at ~3× the scene radius so it extends past the splats.
  const gridSize = radius * 3;
  const grid = new THREE.GridHelper(gridSize, 20, 0x66d6a8, 0x1f4334);
  grid.position.copy(center);
  // Drop the grid to the bottom of the bounding box (Y depends on convention).
  if (box && !box.isEmpty()) {
    grid.position.y = (cameraUpYDown ? box.max.y : box.min.y);
  }
  scene.add(grid);

  const axes = new THREE.AxesHelper(radius * 1.2);
  axes.position.copy(center);
  scene.add(axes);

  helpers = { grid, axes };
}

function removeHelpers() {
  if (!helpers) return;
  const scene = getActiveScene();
  if (scene) {
    if (helpers.grid) scene.remove(helpers.grid);
    if (helpers.axes) scene.remove(helpers.axes);
  }
  helpers.grid?.geometry?.dispose?.();
  helpers.grid?.material?.dispose?.();
  helpers.axes?.geometry?.dispose?.();
  helpers.axes?.material?.dispose?.();
  helpers = null;
}

function setHelpersVisible(visible) {
  if (!helpers) return;
  helpers.grid.visible = visible;
  helpers.axes.visible = visible;
}

/* Build a THREE.Points cloud from the parsed SplatBuffer's centers
   and base colors. This bypasses the library's depth-sorted instanced
   splat-quad pipeline entirely — no worker, no WASM, no transform
   feedback. If the data parsed correctly, dots WILL appear here. */
function buildFallbackPoints(splatBuffer) {
  removeFallbackPoints();
  const count = splatBuffer.getSplatCount?.() ?? 0;
  if (!count) return null;

  const positions = new Float32Array(count * 3);
  const colors    = new Float32Array(count * 3);

  // fillSplatCenterArray(outArray, transform, srcFrom, srcTo, destFrom)
  splatBuffer.fillSplatCenterArray(positions, null, 0, count - 1, 0);

  // Per-splat color extraction. RGBA returned as 0-255; alpha is ignored.
  const tmpColor = new THREE.Vector4();
  let minA = 255, maxA = 0;
  for (let i = 0; i < count; i++) {
    splatBuffer.getSplatColor(i, tmpColor);
    colors[i * 3]     = tmpColor.x / 255;
    colors[i * 3 + 1] = tmpColor.y / 255;
    colors[i * 3 + 2] = tmpColor.z / 255;
    if (tmpColor.w < minA) minA = tmpColor.w;
    if (tmpColor.w > maxA) maxA = tmpColor.w;
  }
  console.log('[SplatViewer] Fallback points alpha range:', minA, '-', maxA);

  // Bounding box from the actual extracted centers — most accurate.
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    box.expandByPoint(tmp);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();

  const size = new THREE.Vector3();
  box.getSize(size);
  const radius = Math.max(size.length() * 0.5, 1);

  const mat = new THREE.PointsMaterial({
    size:        Math.max(radius / 1500, 0.001),
    vertexColors: true,
    sizeAttenuation: true,
    transparent: false,
    depthWrite:  true,
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;     // huge bbox → don't cull on micro-frustums

  fallbackPoints = points;
  return { points, box };
}

function removeFallbackPoints() {
  if (!fallbackPoints) return;
  const scene = getActiveScene();
  if (scene) scene.remove(fallbackPoints);
  fallbackPoints.geometry?.dispose?.();
  fallbackPoints.material?.dispose?.();
  fallbackPoints = null;
}

/* ── Helpers ───────────────────────────────────────────────── */
function setLoading(text) {
  loadingText.textContent = text;
  loadingEl.hidden = false;
}

function clearLoading() {
  loadingEl.hidden = true;
}

function showError(msg) {
  clearLoading();
  // If a scene is already loaded, keep showing it; just alert.
  if (!document.body.classList.contains('scene-loaded')) {
    dropZone.hidden = false;
  }
  alert(msg);
}

/* Position the camera so the entire splat cloud fits in view, with
   a small margin. Without this, scenes captured far from the world
   origin (or at unusual scale) end up off-screen and the user just
   sees a blank canvas. */
function frameSceneToCamera(boxOverride) {
  if (!viewer || !viewer.splatMesh) return;

  let box = boxOverride;
  if (!box) {
    try {
      box = viewer.splatMesh.computeBoundingBox(true);
    } catch (e) {
      console.warn('computeBoundingBox failed:', e);
      return;
    }
  }
  if (!box || box.isEmpty() ||
      !isFinite(box.min.x) || !isFinite(box.max.x)) {
    console.warn('[SplatViewer] Empty/invalid bounding box; skipping auto-frame.');
    return;
  }

  const center = new THREE.Vector3();
  const size   = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  // Use half-diagonal so even a flat / single-axis scene gets a non-zero radius.
  let radius = size.length() * 0.5;
  if (!isFinite(radius) || radius < 1e-4) radius = 1;

  const camera = viewer.camera;
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect || 1;
  const distV = radius / Math.sin(fov / 2);
  const distH = radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
  const distance = Math.max(distV, distH) * 1.5;   // 50 % margin

  // Offset along world +Z (in front of a typical 3DGS scene), then
  // lookAt re-orients with whatever cameraUp the viewer was built with.
  camera.position.set(center.x, center.y, center.z + distance);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far  = Math.max(distance * 100, 100);
  camera.updateProjectionMatrix();

  if (viewer.controls?.target) {
    viewer.controls.target.copy(center);
    viewer.controls.update();
  }
  camera.lookAt(center);
}

function detectFormat(filename) {
  const f = filename.toLowerCase();
  if (f.endsWith('.ksplat')) return GaussianSplats3D.SceneFormat.KSplat;
  if (f.endsWith('.splat'))  return GaussianSplats3D.SceneFormat.Splat;
  return GaussianSplats3D.SceneFormat.Ply;
}

/* Parse a splat file's bytes into a SplatBuffer using the matching
   loader. We do this ourselves (the same way the official demo does)
   instead of letting Viewer.addSplatScene() fetch a blob: URL — that
   path involves a worker fetch that fails silently in some browsers
   and leaves the canvas blank. */
async function fileToSplatBuffer(file) {
  const buf = await file.arrayBuffer();
  const fmt = detectFormat(file.name);
  const minimumAlpha     = 1;     // permissive — match addSplatBuffers options below
  const compressionLevel = 0;     // keep full float precision
  const optimizeSplatData = true; // standard pipeline
  const shDegreeOut      = 0;     // skip spherical harmonics for compatibility

  if (fmt === GaussianSplats3D.SceneFormat.Ply) {
    return GaussianSplats3D.PlyLoader.loadFromFileData(
      buf, minimumAlpha, compressionLevel, optimizeSplatData, shDegreeOut,
    );
  }
  if (fmt === GaussianSplats3D.SceneFormat.Splat) {
    return GaussianSplats3D.SplatLoader.loadFromFileData(
      buf, minimumAlpha, compressionLevel, optimizeSplatData, shDegreeOut,
    );
  }
  return GaussianSplats3D.KSplatLoader.loadFromFileData(buf);
}

/* Read the first 16KB of a PLY file as text to inspect the header.
   We recognise three Gaussian-flavoured PLY shapes:
   • INRIA / Nerfstudio / Postshot — has f_dc_*, scale_*, rot_*, opacity
   • PlayCanvas-compressed         — has packed_position / packed_rotation
   • Generic point clouds with x/y/z + r/g/b will be flagged as "not splat" */
async function inspectPlyHeader(file) {
  const slice = file.slice(0, 16384);
  const text  = await slice.text();
  if (!text.startsWith('ply')) {
    return { isPly: false, isGaussian: false, header: text.slice(0, 200) };
  }
  const endIdx = text.indexOf('end_header');
  const header = endIdx >= 0 ? text.slice(0, endIdx) : text;
  const hasInriaSplats =
    /\bf_dc_0\b/.test(header) &&
    /\bopacity\b/.test(header) &&
    /\bscale_0\b/.test(header) &&
    /\brot_0\b/.test(header);
  const hasPlayCanvasSplats =
    /\bpacked_position\b/.test(header) ||
    /\bpacked_rotation\b/.test(header);
  return {
    isPly: true,
    isGaussian: hasInriaSplats || hasPlayCanvasSplats,
    header,
  };
}

async function disposeViewer() {
  removeHelpers();
  removeFallbackPoints();
  if (viewer) {
    try { await viewer.dispose(); } catch (e) { console.warn('Viewer dispose failed:', e); }
    viewer = null;
  }
  if (threeCtx) {
    cancelAnimationFrame(threeCtx.raf);
    window.removeEventListener('resize', threeCtx.onResize);
    threeCtx.controls.dispose();
    threeCtx.renderer.dispose();
    threeCtx.renderer.domElement.remove();
    threeCtx.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => m.dispose?.());
      }
    });
    threeCtx = null;
  }
  // Library / loader canvases sometimes linger; strip any stray ones.
  document.querySelectorAll('body > canvas').forEach(c => c.remove());

  if (currentObjectURL) {
    URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = null;
  }
}

/* ── Load an .obj file as a regular Three.js mesh scene ──── */
async function loadObj(file) {
  lastFile = file;
  dropZone.hidden = true;
  setLoading(`Loading ${file.name}…`);

  await disposeViewer();

  try {
    const text = await file.text();
    const obj  = new OBJLoader().parse(text);

    // Apply a default material to any mesh that didn't get one from
    // the OBJ (we don't load .mtl), so the geometry is actually visible.
    let meshCount = 0, vertCount = 0;
    obj.traverse(child => {
      if (child.isMesh) {
        meshCount++;
        const g = child.geometry;
        if (g) {
          if (!g.attributes.normal) g.computeVertexNormals();
          vertCount += g.attributes.position?.count ?? 0;
        }
        child.material = new THREE.MeshStandardMaterial({
          color: 0x66d6a8,
          metalness: 0.1,
          roughness: 0.7,
          flatShading: true,
          side: THREE.DoubleSide,
        });
      }
    });

    if (!meshCount) {
      throw new Error('The OBJ contains no mesh geometry.');
    }

    // Scene + lights
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07140f);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xa6f5d2, 0.35);
    fill.position.set(-4, -2, -3);
    scene.add(fill);
    scene.add(obj);

    // Frame
    const box = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    const size   = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    let radius = size.length() * 0.5;
    if (!isFinite(radius) || radius < 1e-4) radius = 1;

    const camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight,
      Math.max(radius / 1000, 0.001),
      Math.max(radius * 1000, 1000),
    );
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = (radius / Math.sin(fov / 2)) * 1.5;
    camera.position.set(center.x, center.y, center.z + distance);
    camera.lookAt(center);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    let raf;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      threeCtx.raf = raf;
    };

    threeCtx = { renderer, scene, camera, controls, onResize, raf: 0 };
    animate();

    buildHelpers(box);

    initialCamPos    = camera.position.clone();
    initialCamTarget = controls.target.clone();

    sceneNameEl.textContent = `${file.name} · ${meshCount} mesh${meshCount > 1 ? 'es' : ''}, ${vertCount.toLocaleString()} verts`;
    sceneNameEl.title       = file.name;
    topbar.hidden           = false;
    controlsEl.hidden       = false;
    document.body.classList.add('scene-loaded');
    clearLoading();

    console.log('[SplatViewer] Loaded OBJ', file.name, {
      meshCount, vertCount,
      bbox: { min: box.min.toArray(), max: box.max.toArray() },
    });
  } catch (err) {
    console.error(err);
    await disposeViewer();
    showError(`Failed to load "${file.name}".\n\n${err?.message || err}`);
  }
}

/* ── Load a user-chosen file ──────────────────────────────── */
async function loadFile(file) {
  if (!file) return;
  if (!/\.(ply|splat|ksplat|obj)$/i.test(file.name)) {
    showError('Please select a .ply, .splat, .ksplat, or .obj file.');
    return;
  }

  // .obj files use a separate Three.js scene rather than the splat viewer.
  if (/\.obj$/i.test(file.name)) {
    return loadObj(file);
  }

  // Pre-flight check for .ply: confirm it actually contains Gaussian splats,
  // not just a regular point cloud or mesh PLY (which the renderer can't show).
  if (/\.ply$/i.test(file.name)) {
    try {
      const info = await inspectPlyHeader(file);
      if (!info.isPly) {
        showError(`"${file.name}" doesn't look like a PLY file (no "ply" magic at the start).`);
        return;
      }
      if (!info.isGaussian) {
        console.warn('PLY header (first 8KB):\n', info.header);
        showError(
          `"${file.name}" is a PLY file but doesn't contain Gaussian-Splat data.\n\n` +
          `It's missing the f_dc_*, scale_*, rot_*, and/or opacity properties ` +
          `produced by 3D Gaussian Splatting pipelines (e.g. INRIA's gaussian-splatting, ` +
          `Polycam, Postshot, Luma, Nerfstudio's splatfacto).\n\n` +
          `Regular point-cloud or mesh PLYs aren't supported by this viewer.`
        );
        return;
      }
    } catch (e) {
      console.warn('PLY pre-check failed (continuing anyway):', e);
    }
  }

  lastFile = file;
  dropZone.hidden = true;
  setLoading(`Parsing ${file.name}…`);

  await disposeViewer();

  try {
    // ── Step 1: Parse the bytes into a SplatBuffer ourselves. ──
    // (Same approach as the official mkkellogg demo. Catches parse
    //  errors here instead of inside the viewer's worker.)
    const splatBuffer = await fileToSplatBuffer(file);
    const preCount    = splatBuffer?.getSplatCount?.() ?? 0;
    if (!preCount) {
      throw new Error('Parser produced 0 splats. The file may be empty or in an ' +
                      'unsupported sub-format (e.g. PlayCanvas-compressed PLY).');
    }
    console.log('[SplatViewer] Parsed', file.name, '->', preCount, 'splats');

    setLoading(`Extracting points (${preCount.toLocaleString()} splats)…`);
    // Build the fallback Points cloud before the viewer is constructed —
    // we'll add it to viewer.threeScene below, and use its bounding box
    // (computed from raw center floats) to frame the camera reliably.
    const fb = buildFallbackPoints(splatBuffer);
    const fbBox = fb?.box ?? null;
    console.log('[SplatViewer] Fallback bbox',
      fbBox ? { min: fbBox.min.toArray(), max: fbBox.max.toArray() } : null);

    setLoading(`Building viewer (${preCount.toLocaleString()} splats)…`);

    // ── Step 2: Build the viewer and hand it the SplatBuffer. ──
    viewer = new GaussianSplats3D.Viewer({
      'rootElement':                document.body,
      'cameraUp':                   cameraUpYDown ? [0, -1, 0] : [0, 1, 0],
      'initialCameraPosition':      [0, 0, 5],
      'initialCameraLookAt':        [0, 0, 0],
      'sphericalHarmonicsDegree':   0,        // match the loader (skip SH)
      'selfDrivenMode':             true,
      'useBuiltInControls':         true,
      'sharedMemoryForWorkers':     false,    // no SAB on static hosting
      'gpuAcceleratedSort':         true,
      'halfPrecisionCovariancesOnGPU': false, // demo's setting — broader compat
      'antialiased':                false,
      'splatRenderMode':            GaussianSplats3D.SplatRenderMode.ThreeD,
    });

    await viewer.addSplatBuffers(
      [splatBuffer],
      [{ 'splatAlphaRemovalThreshold': 0 }],   // permissive: don't cull anything
      true,    // finalBuild
      false,   // showLoadingUI
      false,   // showLoadingUIForSplatTreeBuild
      false,   // replaceExisting
      true,    // enableRenderBeforeFirstSort — render even if depth-sort stalls
    );

    viewer.start();

    // Diagnostics in the console — invaluable when something looks blank.
    const splatCount = viewer.splatMesh?.getSplatCount?.() ?? 0;
    let bbox = null;
    try { bbox = viewer.splatMesh.computeBoundingBox(true); } catch {}
    console.log('[SplatViewer] Loaded', file.name, {
      splatCount,
      bbox: bbox ? { min: bbox.min.toArray(), max: bbox.max.toArray() } : null,
      cameraUpYDown,
    });

    if (!splatCount) {
      throw new Error('The viewer accepted the buffer but reports 0 splats.');
    }

    // Add the fallback Points cloud INTO the viewer's scene so it gets
    // rendered alongside (or instead of) the splat mesh.
    if (fallbackPoints) {
      fallbackPoints.visible = fallbackVisible;
      viewer.threeScene.add(fallbackPoints);
    }

    // Use the fallback box for helpers + framing if it's valid;
    // it's computed from raw float centers so it's the most reliable.
    const finalBox = (fbBox && !fbBox.isEmpty()) ? fbBox : bbox;
    buildHelpers(finalBox);

    // Periodic check on splatRenderReady to catch a stalled sort worker.
    let pollCount = 0;
    const pollId = setInterval(() => {
      if (!viewer) { clearInterval(pollId); return; }
      console.log('[SplatViewer] tick', {
        splatRenderReady: viewer.splatRenderReady,
        camPos: viewer.camera?.position?.toArray?.().map(n => +n.toFixed(2)),
      });
      if (++pollCount >= 5) clearInterval(pollId);
    }, 1000);

    // Auto-frame the camera around the splat scene's bounding box,
    // because uploaded scenes are rarely centered at the origin or
    // sized to fit the default camera distance.
    frameSceneToCamera(finalBox);

    // Cache the framed camera state so "Reset" can restore it.
    initialCamPos    = viewer.camera.position.clone();
    initialCamTarget = viewer.controls?.target?.clone() ?? new THREE.Vector3(0, 0, 0);

    sceneNameEl.textContent = `${file.name} · ${splatCount.toLocaleString()} splats`;
    sceneNameEl.title       = file.name;
    topbar.hidden           = false;
    controlsEl.hidden       = false;
    document.body.classList.add('scene-loaded');
    clearLoading();
  } catch (err) {
    console.error(err);
    await disposeViewer();
    showError(
      `Failed to load "${file.name}".\n\n` +
      `${err?.message || err}\n\n` +
      `See the browser console (F12) for details.`
    );
  }
}

/* ── File input ────────────────────────────────────────────── */
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';   // allow re-selecting the same file later
  if (file) loadFile(file);
});

loadNewBtn.addEventListener('click', () => fileInput.click());

/* ── Drag and drop (anywhere on the page) ─────────────────── */
let dragDepth = 0;        // counts nested dragenter/leave events

window.addEventListener('dragenter', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  dropZone.hidden = false;          // show overlay even mid-session
  dropZone.classList.add('drop-zone--active');
});

window.addEventListener('dragover', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropZone.classList.remove('drop-zone--active');
    if (document.body.classList.contains('scene-loaded')) {
      dropZone.hidden = true;        // re-hide if a scene is up
    }
  }
});

window.addEventListener('drop', e => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('drop-zone--active');
  const file = e.dataTransfer.files?.[0];
  if (file) loadFile(file);
});

/* ── Reset camera ──────────────────────────────────────────── */
resetBtn.addEventListener('click', () => {
  const cam  = getActiveCamera();
  const ctls = getActiveControls();
  if (!cam || !initialCamPos) return;
  cam.position.copy(initialCamPos);
  if (ctls?.target) {
    ctls.target.copy(initialCamTarget);
    ctls.update();
  }
});

/* ── Flip up axis (splat scenes only — OBJ uses Y-up) ─────── */
flipBtn.addEventListener('click', () => {
  if (!lastFile) return;
  if (/\.obj$/i.test(lastFile.name)) return;
  cameraUpYDown = !cameraUpYDown;
  loadFile(lastFile);
});

/* ── Toggle grid + axes helpers ──────────────────────────── */
let helpersVisible = true;
gridBtn.addEventListener('click', () => {
  helpersVisible = !helpersVisible;
  setHelpersVisible(helpersVisible);
  gridBtn.style.opacity = helpersVisible ? '1' : '0.5';
});

/* ── Toggle the fallback Points cloud ──────────────────────
   With this on you see the raw splat centers as colored dots,
   independent of the splat shader / sort pipeline. */
pointBtn.addEventListener('click', () => {
  fallbackVisible = !fallbackVisible;
  if (fallbackPoints) fallbackPoints.visible = fallbackVisible;
  pointBtn.style.opacity = fallbackVisible ? '1' : '0.5';
});

/* ── Controls help toggle ──────────────────────────────────── */
controlsToggle.addEventListener('click', () => {
  const open = controlsPanel.hidden;
  controlsPanel.hidden = !open;
  controlsToggle.setAttribute('aria-expanded', String(open));
});

/* ── Keyboard fly controls (WASD + QE) ─────────────────────── */
const keys = Object.create(null);
const isTextInput = el =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

window.addEventListener('keydown', e => {
  if (isTextInput(document.activeElement)) return;
  keys[e.code] = true;
});
window.addEventListener('keyup', e => {
  keys[e.code] = false;
});
// Don't keep stuck keys when the tab loses focus.
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
});

const fwd      = new THREE.Vector3();
const right    = new THREE.Vector3();
const worldUp  = new THREE.Vector3(0, 1, 0);
const move     = new THREE.Vector3();
let   prevTime = performance.now();

function tickKeyboard() {
  requestAnimationFrame(tickKeyboard);
  const now = performance.now();
  const dt  = (now - prevTime) / 1000;
  prevTime  = now;

  const camera = getActiveCamera();
  const ctls   = getActiveControls();
  if (!camera) return;

  let dx = 0, dy = 0, dz = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    dz -= 1;
  if (keys['KeyS'] || keys['ArrowDown'])  dz += 1;
  if (keys['KeyA'] || keys['ArrowLeft'])  dx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
  if (keys['KeyQ']) dy -= 1;
  if (keys['KeyE']) dy += 1;
  if (dx === 0 && dy === 0 && dz === 0) return;

  // Speed scales with distance from the orbit target so the controls
  // feel right whether the user is far away or up close.
  const target = ctls?.target ?? new THREE.Vector3();
  const dist = camera.position.distanceTo(target);
  const speed = Math.max(0.5, dist) * 1.2;

  camera.getWorldDirection(fwd);
  right.crossVectors(fwd, worldUp).normalize();

  move.set(0, 0, 0)
    .addScaledVector(fwd,     -dz * speed * dt)
    .addScaledVector(right,    dx * speed * dt)
    .addScaledVector(worldUp,  dy * speed * dt);

  camera.position.add(move);
  if (ctls?.target) {
    ctls.target.add(move);
    ctls.update();
  }
}
tickKeyboard();

/* ── Prevent context menu on right-click drag (used for pan) ─ */
window.addEventListener('contextmenu', e => {
  if (document.body.classList.contains('scene-loaded')) e.preventDefault();
});
