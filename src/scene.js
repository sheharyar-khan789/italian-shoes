import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Placeholder product model (unbranded sneaker with three material variants), pinned to the
// three.js release we ship. Replace with the brand's own product model when supplied.
const MODEL_URL =
  "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/MaterialsVariantsShoe/glTF/MaterialsVariantsShoe.gltf";

const SWATCHES = { midnight: "#1d5f8f", beach: "#c99389", street: "linear-gradient(135deg, #151515 55%, #c22a2e 55%)" };

// World-space footprint the composition must fit inside the layout's stage anchor.
const STAGE_W = 3.7;
const STAGE_H = 3.0;
const SHOE_LENGTH = 2.75;
const FLOAT = 0.24;
const BASE_YAW = Math.PI + 0.58; // toe turned towards the headline

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const damp = (current, target, lambda, dt) => THREE.MathUtils.damp(current, target, lambda, dt);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function createStage({ hero, canvas, anchor, finishes, status, reducedMotion }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
  const lookAt = new THREE.Vector3(0, 0.62, 0);

  /* ───── Lighting: warm key from above-left, cool rim behind, low fill ───── */
  const key = new THREE.SpotLight(0xffe4c4, 0, 0, 0.42, 0.85, 2);
  key.position.set(-2.6, 7.2, 3.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 3;
  key.shadow.camera.far = 14;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 6;
  scene.add(key, key.target);

  const rim = new THREE.DirectionalLight(0xc9d6ff, 0);
  rim.position.set(4.5, 3.2, -4.5);
  scene.add(rim);

  const fill = new THREE.HemisphereLight(0xfff1e0, 0x0a0908, 0);
  scene.add(fill);

  const LIGHTS = { key: 85, rim: 1.6, fill: 0.5 };

  /* ───── Architectural plinth ───── */
  const stage = new THREE.Group();
  scene.add(stage);

  const plinthSide = new THREE.MeshStandardMaterial({ color: 0x181512, roughness: 0.78, metalness: 0.05 });
  const plinthTop = new THREE.MeshStandardMaterial({ color: 0x1f1b18, roughness: 0.32, metalness: 0.05 });
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.62, 128, 1), [plinthSide, plinthTop, plinthSide]);
  plinth.position.y = -0.31;
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  stage.add(plinth);

  // A fine bronze inlay where the top meets the side.
  const inlay = new THREE.Mesh(
    new THREE.TorusGeometry(1.5, 0.006, 8, 200),
    new THREE.MeshStandardMaterial({ color: 0xb8a081, roughness: 0.35, metalness: 0.9 }),
  );
  inlay.rotation.x = Math.PI / 2;
  stage.add(inlay);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.45 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.62;
  floor.receiveShadow = true;
  stage.add(floor);

  // Soft contact shadow beneath the floating shoe (complements the key light's cast shadow).
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, depthWrite: false, opacity: 0.55 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.003;
  blob.scale.set(2.9, 1.25, 1);
  stage.add(blob);

  const pivot = new THREE.Group(); // yaw / tilt applied here
  pivot.position.y = FLOAT;
  stage.add(pivot);

  /* ───── Layout fitting: center the world on the DOM stage anchor ───── */
  let W = 1;
  let H = 1;
  const fit = () => {
    const hr = hero.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    W = Math.max(1, hr.width);
    H = Math.max(1, hr.height);
    const dpr = Math.min(window.devicePixelRatio || 1, W < 768 ? 1.5 : 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);

    const aw = Math.max(200, ar.width);
    const ah = Math.max(200, ar.height);
    const ax = ar.left - hr.left + ar.width / 2;
    const ay = ar.top - hr.top + ar.height / 2;

    const worldPerPx = Math.max(STAGE_W / aw, STAGE_H / ah);
    const visibleH = worldPerPx * H;
    camera.userData.distance = clamp(visibleH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))), 6, 40);
    camera.aspect = W / H;
    camera.setViewOffset(W, H, W / 2 - ax, H / 2 - ay, W, H);
    camera.updateProjectionMatrix();

    hero.style.setProperty("--stage-x", `${((ax / W) * 100).toFixed(2)}%`);
    hero.style.setProperty("--stage-y", `${((ay / H) * 100).toFixed(2)}%`);
  };
  fit();
  new ResizeObserver(fit).observe(hero);
  window.addEventListener("resize", fit);

  /* ───── Input: subtle parallax + drag to turn ───── */
  const pointer = { x: 0, y: 0 };
  let userYaw = 0;
  let yawVelocity = 0;
  let drag = null;

  window.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "mouse") return;
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    },
    { passive: true },
  );

  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: e.pointerType === "mouse" };
    yawVelocity = 0;
    if (e.pointerType === "mouse") {
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("is-dragging");
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    // On touch, only take over clearly horizontal gestures; vertical ones keep scrolling the page.
    if (!drag.horizontal) {
      if (Math.abs(e.clientY - drag.y) > Math.abs(dx)) return (drag = null);
      if (Math.abs(dx) < 6) return;
      drag.horizontal = true;
    }
    drag.x = e.clientX;
    userYaw += dx * 0.009;
    yawVelocity = dx * 0.009 * 60;
  });
  const endDrag = () => {
    drag = null;
    canvas.classList.remove("is-dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  /* ───── Load product model ───── */
  const loaderBar = hero.querySelector(".loader");
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_url, loaded, total) => loaderBar.style.setProperty("--progress", (loaded / Math.max(total, 1)).toFixed(3));

  let introStart = null;
  const begin = () => {
    document.body.classList.add("is-ready", "is-lit");
    introStart = performance.now();
  };

  new GLTFLoader(manager)
    .loadAsync(MODEL_URL)
    .then((gltf) => {
      const model = gltf.scene;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      // Normalise: length along X, scaled to SHOE_LENGTH, sole resting at y = 0, centred.
      let box = new THREE.Box3().setFromObject(model);
      let size = box.getSize(new THREE.Vector3());
      if (size.z > size.x) model.rotation.y = Math.PI / 2;
      box = new THREE.Box3().setFromObject(model);
      size = box.getSize(new THREE.Vector3());
      model.scale.setScalar(SHOE_LENGTH / Math.max(size.x, size.z));
      box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;
      model.position.y -= box.min.y;
      pivot.add(model);

      setupVariants(gltf, model, finishes, status);
      begin();
    })
    .catch((err) => {
      console.warn("Product model could not be loaded; showing the empty studio.", err);
      status.textContent = "Product view unavailable";
      begin();
    });

  /* ───── Render loop (paused off-screen / hidden tab) ───── */
  const clock = new THREE.Clock();
  let visible = true;
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    renderer.setAnimationLoop(visible && !document.hidden ? tick : null);
  }).observe(hero);
  document.addEventListener("visibilitychange", () => renderer.setAnimationLoop(visible && !document.hidden ? tick : null));

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    document.body.classList.remove("is-ready");
    document.body.classList.add("no-webgl");
  });

  const state = { yaw: BASE_YAW, tilt: 0, azimuth: 0, lift: 0, scroll: 0 };

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    const intro = introStart === null ? 0 : reducedMotion ? 1 : clamp((performance.now() - introStart) / 2600, 0, 1);
    const k = easeOutCubic(intro);

    key.intensity = LIGHTS.key * k;
    rim.intensity = LIGHTS.rim * k;
    fill.intensity = LIGHTS.fill * (0.25 + 0.75 * k);

    if (!drag) {
      userYaw += yawVelocity * dt;
      yawVelocity = damp(yawVelocity, 0, 3.5, dt);
    }

    const motion = reducedMotion ? 0 : 1;
    const scroll = motion * clamp(window.scrollY / Math.max(H, 1), 0, 1);
    state.scroll = damp(state.scroll, scroll, 6, dt);

    const sway = motion * Math.sin(t * 0.32) * 0.09;
    const targetYaw = BASE_YAW + userYaw + sway + motion * pointer.x * 0.22 + state.scroll * 1.1 - (1 - k) * 1.3;
    state.yaw = damp(state.yaw, targetYaw, 4, dt);
    state.tilt = damp(state.tilt, motion * pointer.y * 0.05, 3, dt);
    state.azimuth = damp(state.azimuth, motion * pointer.x * 0.06, 2.5, dt);

    const bob = motion * Math.sin(t * 0.9) * 0.025;
    pivot.position.y = FLOAT + bob + (1 - k) * 0.7;
    pivot.rotation.set(state.tilt, state.yaw, motion * Math.sin(t * 0.6) * 0.012);

    // Contact shadow tightens as the shoe settles towards the plinth.
    const height = pivot.position.y;
    blob.material.opacity = 0.6 * k * clamp(1 - (height - FLOAT) * 1.2, 0.2, 1);
    blob.scale.set(2.9 + height * 0.6, 1.2 + height * 0.3, 1);

    stage.position.y = -state.scroll * 0.35;

    const d = camera.userData.distance * (1 + (1 - k) * 0.08);
    const elevation = 0.2 + state.scroll * 0.12;
    const az = state.azimuth;
    camera.position.set(
      Math.sin(az) * Math.cos(elevation) * d,
      lookAt.y + Math.sin(elevation) * d,
      Math.cos(az) * Math.cos(elevation) * d,
    );
    camera.lookAt(lookAt);

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(tick);
}

/* KHR_materials_variants: the model ships alternative finishes; expose them as a picker. */
function setupVariants(gltf, model, container, status) {
  const ext = gltf.parser.json.extensions?.KHR_materials_variants;
  if (!ext?.variants?.length) {
    status.textContent = "";
    return;
  }
  const names = ext.variants.map((v) => v.name);
  const parser = gltf.parser;

  const select = async (index) => {
    const swaps = [];
    model.traverse((o) => {
      const meta = o.userData.gltfExtensions?.KHR_materials_variants;
      if (!o.isMesh || !meta) return;
      o.userData.originalMaterial ??= o.material;
      const mapping = meta.mappings.find((m) => m.variants.includes(index));
      if (!mapping) {
        o.material = o.userData.originalMaterial;
        return;
      }
      swaps.push(
        parser.getDependency("material", mapping.material).then((mat) => {
          o.material = mat;
          parser.assignFinalMaterial(o);
        }),
      );
    });
    await Promise.all(swaps);
    status.textContent = `Finish — ${title(names[index])}`;
    status.closest(".hero")?.dispatchEvent(new CustomEvent("finishchange", { detail: names[index] }));
    container.querySelectorAll(".finish").forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
  };

  names.forEach((name, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "finish";
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = `<span class="finish__dot" aria-hidden="true"></span>${title(name)}`;
    btn.style.setProperty("--swatch", SWATCHES[name.toLowerCase()] ?? "#cfc6b8");
    btn.addEventListener("click", () => select(i));
    container.append(btn);
  });
  container.hidden = false;

  const preferred = names.findIndex((n) => n.toLowerCase() === "beach");
  select(preferred >= 0 ? preferred : 0);
}

function radialTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(0,0,0,0.9)");
  grad.addColorStop(0.45, "rgba(0,0,0,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
