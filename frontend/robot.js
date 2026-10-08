
/* ============================================================
   CareerOS — Interactive 3D Robot
   Uses Three.js
   ============================================================ */

(function initRobot() {

  const host = document.getElementById("hero-robot");

  if (!host) return;

  /* ============ FALLBACK ============ */

  function showFallback() {

    host.hidden = true;

    const graph = document.getElementById("hero-graph");

    if (graph) {
      graph.style.display = "flex";
    }

  }

  if (typeof THREE === "undefined") {
    showFallback();
    return;
  }

  const reduceMotion = matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const landing = document.getElementById("landing-view");


  /* ============ RENDERER ============ */

  let renderer;

  try {

    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true
    });

  } catch (error) {

    showFallback();
    return;

  }

  renderer.setPixelRatio(
    Math.min(devicePixelRatio || 1, 2)
  );

  renderer.outputEncoding = THREE.sRGBEncoding;

  host.appendChild(renderer.domElement);

  renderer.domElement.setAttribute(
    "aria-hidden",
    "true"
  );


  /* ============ SCENE AND CAMERA ============ */

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    32,
    1,
    0.1,
    50
  );

  camera.position.set(0, 0.55, 8.2);

  camera.lookAt(0, 0.2, 0);


  /* ============ LIGHTING ============ */

  scene.add(
    new THREE.HemisphereLight(
      0xdfe6ff,
      0x1a1030,
      0.9
    )
  );

  const key = new THREE.DirectionalLight(
    0xffffff,
    1.1
  );

  key.position.set(3, 4, 5);

  scene.add(key);


  const violet = new THREE.PointLight(
    0x8b5cf6,
    1.6,
    14
  );

  violet.position.set(-4, 1, 3);

  scene.add(violet);


  const cyanRim = new THREE.PointLight(
    0x22d3ee,
    1.6,
    14
  );

  cyanRim.position.set(4, 2, -2);

  scene.add(cyanRim);


  /* ============ MATERIALS ============ */

  const shell = new THREE.MeshStandardMaterial({
    color: 0xe9edf7,
    roughness: 0.28,
    metalness: 0.25
  });

  const dark = new THREE.MeshStandardMaterial({
    color: 0x0b0d14,
    roughness: 0.15,
    metalness: 0.6
  });

  const joint = new THREE.MeshStandardMaterial({
    color: 0x1b2030,
    roughness: 0.5,
    metalness: 0.5
  });

  const violetMat = new THREE.MeshStandardMaterial({
    color: 0x8b5cf6,
    roughness: 0.3,
    metalness: 0.4,
    emissive: 0x3b1d8a,
    emissiveIntensity: 0.6
  });

  const glowCyan = new THREE.MeshBasicMaterial({
    color: 0x22d3ee
  });


  /* ============ MESH HELPER ============ */

  const mesh = (
    geo,
    mat,
    x = 0,
    y = 0,
    z = 0,
    sx = 1,
    sy = 1,
    sz = 1
  ) => {

    const m = new THREE.Mesh(geo, mat);

    m.position.set(x, y, z);

    m.scale.set(sx, sy, sz);

    return m;

  };


  /* ============ ROBOT ROOT ============ */

  const robot = new THREE.Group();

  scene.add(robot);


  /* ============ BODY ============ */

  const body = new THREE.Group();

  robot.add(body);

  body.add(
    mesh(
      new THREE.SphereGeometry(1, 48, 32),
      shell,
      0,
      -0.95,
      0,
      0.82,
      0.95,
      0.68
    )
  );


  /* Chest core */

  const core = mesh(
    new THREE.SphereGeometry(0.17, 24, 16),
    glowCyan,
    0,
    -0.78,
    0.66
  );

  body.add(core);


  const coreRing = mesh(
    new THREE.TorusGeometry(0.27, 0.035, 12, 40),
    violetMat,
    0,
    -0.78,
    0.64
  );

  body.add(coreRing);


  /* Belt */

  const belt = mesh(
    new THREE.TorusGeometry(0.7, 0.05, 12, 48),
    joint,
    0,
    -1.35,
    0,
    1,
    0.85,
    1
  );

  belt.rotateX(Math.PI / 2);

  body.add(belt);


  /* ============ ARMS ============ */

  function makeArm(side) {

    const group = new THREE.Group();

    group.position.set(
      side * 0.92,
      -0.62,
      0
    );

    group.add(
      mesh(
        new THREE.SphereGeometry(0.17, 20, 14),
        joint
      )
    );

    const arm = mesh(
      new THREE.CylinderGeometry(
        0.1,
        0.09,
        0.62,
        16
      ),
      shell,
      0,
      -0.34,
      0
    );

    group.add(arm);

    group.add(
      mesh(
        new THREE.SphereGeometry(0.16, 20, 14),
        violetMat,
        0,
        -0.74,
        0
      )
    );

    group.rotation.z = side * 0.18;

    return group;

  }

  const armL = makeArm(-1);

  const armR = makeArm(1);

  body.add(armL, armR);


  /* ============ NECK ============ */

  robot.add(
    mesh(
      new THREE.CylinderGeometry(
        0.2,
        0.26,
        0.28,
        20
      ),
      joint,
      0,
      0.02,
      0
    )
  );


  /* ============ HEAD ============ */

  const head = new THREE.Group();

  head.position.set(0, 0.78, 0);

  robot.add(head);


  /* Head shell */

  head.add(
    mesh(
      new THREE.SphereGeometry(1, 56, 40),
      shell,
      0,
      0,
      0,
      1.12,
      0.88,
      0.98
    )
  );


  /* Face visor */

  head.add(
    mesh(
      new THREE.SphereGeometry(1, 48, 32),
      dark,
      0,
      0.02,
      0.28,
      0.92,
      0.62,
      0.78
    )
  );


  /* ============ EARS ============ */

  for (const side of [-1, 1]) {

    const ear = mesh(
      new THREE.CylinderGeometry(
        0.2,
        0.2,
        0.2,
        24
      ),
      violetMat,
      side * 1.08,
      0,
      0
    );

    ear.rotation.z = Math.PI / 2;

    head.add(ear);


    const cap = mesh(
      new THREE.CylinderGeometry(
        0.11,
        0.11,
        0.24,
        20
      ),
      joint,
      side * 1.08,
      0,
      0
    );

    cap.rotation.z = Math.PI / 2;

    head.add(cap);

  }


  /* ============ ANTENNA ============ */

  head.add(
    mesh(
      new THREE.CylinderGeometry(
        0.03,
        0.03,
        0.4,
        10
      ),
      joint,
      0,
      0.98,
      0
    )
  );


  const bulb = mesh(
    new THREE.SphereGeometry(0.11, 20, 14),
    glowCyan,
    0,
    1.22,
    0
  );

  head.add(bulb);


  /* ============ EYES ============ */

  const eyes = new THREE.Group();

  eyes.position.set(0, 0.06, 0.93);

  head.add(eyes);


  const eyeL = mesh(
    new THREE.SphereGeometry(0.15, 24, 16),
    glowCyan,
    -0.33,
    0,
    0,
    1,
    1.35,
    0.5
  );


  const eyeR = mesh(
    new THREE.SphereGeometry(0.15, 24, 16),
    glowCyan,
    0.33,
    0,
    0,
    1,
    1.35,
    0.5
  );

  eyes.add(eyeL, eyeR);


  /* ============ SMILE ============ */

  const mouth = mesh(
    new THREE.TorusGeometry(
      0.16,
      0.022,
      8,
      24,
      Math.PI
    ),
    glowCyan,
    0,
    -0.22,
    0
  );

  mouth.rotation.z = Math.PI;

  eyes.add(mouth);


  /* ============ FLOOR GLOW ============ */

  const glowCanvas = document.createElement("canvas");

  glowCanvas.width = 128;
  glowCanvas.height = 128;

  const ctx = glowCanvas.getContext("2d");

  const gradient = ctx.createRadialGradient(
    64, 64, 0,
    64, 64, 64
  );

  gradient.addColorStop(
    0,
    "rgba(139,92,246,.75)"
  );

  gradient.addColorStop(
    1,
    "rgba(139,92,246,0)"
  );

  ctx.fillStyle = gradient;

  ctx.fillRect(0, 0, 128, 128);


  const glowTexture = new THREE.CanvasTexture(
    glowCanvas
  );


  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 3.4),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false
    })
  );

  floor.rotation.x = -Math.PI / 2;

  floor.position.y = -2.5;

  scene.add(floor);


  /* ============ POINTER TRACKING ============ */

  const target = {
    yaw: 0,
    pitch: 0,
    nx: 0
  };


  function aim(clientX, clientY) {

    const rect = host.getBoundingClientRect();

    const centerX = rect.left + rect.width / 2;

    const centerY = rect.top + rect.height * 0.35;

    const nx = Math.max(
      -1,
      Math.min(
        1,
        (clientX - centerX) / (innerWidth / 2)
      )
    );

    const ny = Math.max(
      -1,
      Math.min(
        1,
        (clientY - centerY) / (innerHeight / 2)
      )
    );

    target.nx = nx;

    target.yaw = nx * 0.75;

    target.pitch = ny * 0.45;

  }


  addEventListener(
    "pointermove",
    e => aim(e.clientX, e.clientY),
    { passive: true }
  );


  document.addEventListener("mouseleave", () => {

    target.yaw = 0;
    target.pitch = 0;
    target.nx = 0;

  });


  /* ============ REACT TO TYPING ============ */

  let listen = 0;

  const jobInput = document.getElementById("job-input");

  if (jobInput) {

    jobInput.addEventListener("input", () => {
      listen = 1;
    });

  }


  /* ============ RESPONSIVE RESIZING ============ */

  function resize() {

    const width = host.clientWidth;

    const height = host.clientHeight;

    if (!width || !height) return;

    renderer.setSize(width, height, false);

    renderer.domElement.style.width = width + "px";

    renderer.domElement.style.height = height + "px";

    camera.aspect = width / height;

    camera.position.z = camera.aspect < 0.9
      ? 9.6
      : 8.2;

    camera.updateProjectionMatrix();

  }


  new ResizeObserver(resize).observe(host);

  resize();


  /* ============ ANIMATION ============ */

  const current = {
    yaw: 0,
    pitch: 0,
    nx: 0
  };

  let last = performance.now();

  let nextBlink = last + 2500;

  let blinkEnd = 0;


  function animate(now) {

    requestAnimationFrame(animate);

    const dt = Math.min(
      (now - last) / 1000,
      0.05
    );

    last = now;


    /* Pause when landing page isn't visible */

    if (
      document.hidden ||
      !landing.classList.contains("active")
    ) {
      return;
    }


    /* Smooth movement */

    const smoothing = 1 - Math.exp(-dt * 7);

    current.yaw += (
      target.yaw - current.yaw
    ) * smoothing;

    current.pitch += (
      target.pitch - current.pitch
    ) * smoothing;

    current.nx += (
      target.nx - current.nx
    ) * smoothing;


    listen = Math.max(
      0,
      listen - dt * 1.6
    );


    const time = now / 1000;

    const nod = Math.sin(time * 14) * 0.07 * listen;


    /* Head movement */

    head.rotation.y = current.yaw;

    head.rotation.x = current.pitch + nod;

    head.rotation.z = -current.yaw * 0.08;


    /* Body follows the head */

    body.rotation.y = current.yaw * 0.28;


    /* Eye tracking */

    eyes.position.x = current.nx * 0.07;

    eyes.position.y = 0.06 - current.pitch * 0.05;


    /* Blinking */

    if (now > nextBlink) {

      blinkEnd = now + 130;

      nextBlink = now + 2500 + Math.random() * 3000;

    }

    const blinking = now < blinkEnd;

    const eyeY = blinking
      ? 0.12
      : 1.35 + listen * 0.25;

    eyeL.scale.y = eyeY;

    eyeR.scale.y = eyeY;


    /* Floating animation */

    if (!reduceMotion) {

      robot.position.y = Math.sin(time * 1.6) * 0.12;

      armL.rotation.z =
        -0.18 - Math.sin(time * 1.6 + 1) * 0.06;

      armR.rotation.z =
        0.18 + Math.sin(time * 1.6) * 0.06;


      const scale = 1 + Math.sin(time * 3) * 0.12;

      bulb.scale.setScalar(scale);

      core.scale.setScalar(
        1 + Math.sin(time * 2.4) * 0.12
      );

      coreRing.rotation.z = time * 0.8;

      floor.scale.setScalar(
        1 - Math.sin(time * 1.6) * 0.05
      );

    }


    /* Render robot */

    renderer.render(scene, camera);

  }


  requestAnimationFrame(animate);

})();
