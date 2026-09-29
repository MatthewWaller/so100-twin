import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import URDFLoader, { type URDFRobot } from 'urdf-loader';
import type { JointName } from './episode';

const URDF_URL = `${import.meta.env.BASE_URL}urdf/so100/so100.urdf`;

/** Solid arm = observed state; translucent ghost = commanded action. */
export class TwinScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 20);
  readonly controls: OrbitControls;
  state?: URDFRobot;
  ghost?: URDFRobot;
  private readonly container: HTMLElement;
  /** Render on demand: only redraw when the pose, camera or size changed. */
  private dirty = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    const bg = new THREE.Color('#0b0f14');
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 1.2, 3.2);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    this.camera.position.set(0.42, 0.34, 0.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.12, 0.08);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 2;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.addLights();
    this.addFloor();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight('#bcd7ff', '#1a1510', 0.7));
    const key = new THREE.DirectionalLight('#fff3e0', 2.4);
    key.position.set(0.6, 1.1, 0.7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -0.5;
    key.shadow.camera.right = 0.5;
    key.shadow.camera.top = 0.5;
    key.shadow.camera.bottom = -0.5;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 3;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#5ab0ff', 1.3);
    rim.position.set(-0.8, 0.5, -0.9);
    this.scene.add(rim);
  }

  private addFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3, 64),
      new THREE.MeshStandardMaterial({ color: '#111820', roughness: 0.95, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const fine = new THREE.GridHelper(2, 80, '#1d2a36', '#1d2a36');
    fine.position.y = 0.0005;
    this.scene.add(fine);
    const coarse = new THREE.GridHelper(2, 8, '#2c4256', '#2c4256');
    coarse.position.y = 0.001;
    this.scene.add(coarse);
  }

  async loadRobot(): Promise<void> {
    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    const done = new Promise<void>((resolve, reject) => {
      manager.onLoad = () => resolve();
      manager.onError = (url) => reject(new Error(`Failed to load ${url}`));
    });
    const robot = await loader.loadAsync(URDF_URL);
    await done; // wait for every STL mesh before cloning

    const ghost = robot.clone(true) as URDFRobot;
    styleSolid(robot);
    styleGhost(ghost);

    for (const r of [robot, ghost]) {
      // URDF is Z-up with the arm facing -Y; three.js is Y-up. Face the arm toward +Z.
      r.rotation.x = -Math.PI / 2;
      this.scene.add(r);
    }
    this.state = robot;
    this.ghost = ghost;
  }

  setPose(robot: URDFRobot | undefined, q: Partial<Record<JointName, number>>): void {
    if (!robot) return;
    for (const [name, value] of Object.entries(q)) {
      if (value !== undefined && robot.joints[name]) robot.joints[name].setJointValue(value);
    }
    this.dirty = true;
  }

  /** Camera presets. "top" roughly matches an overhead camera looking down at the arm. */
  setView(name: string): void {
    const views: Record<string, [number, number, number, number, number, number]> = {
      default: [0.42, 0.34, 0.5, 0, 0.12, 0.08],
      top: [0, 0.78, -0.06, 0, 0, 0.16],
      side: [0.6, 0.18, 0.1, 0, 0.14, 0.1],
      front: [0, 0.22, 0.75, 0, 0.14, 0.05],
    };
    // Also accepts "px,py,pz,tx,ty,tz" (camera position, orbit target) for custom shots.
    const custom = name.split(',').map(Number);
    const v = custom.length === 6 && custom.every(Number.isFinite)
      ? (custom as [number, number, number, number, number, number])
      : (views[name] ?? views.default);
    this.camera.position.set(v[0], v[1], v[2]);
    this.controls.target.set(v[3], v[4], v[5]);
    this.controls.update();
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Called every animation frame; cheap when nothing changed. */
  frame(): void {
    const moved = this.controls.update();
    if (moved || this.dirty) this.render();
  }

  render(): void {
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }
}

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function styleSolid(robot: URDFRobot): void {
  for (const m of meshes(robot)) {
    const src = m.material as THREE.MeshPhongMaterial;
    const color = src.color ? src.color.clone() : new THREE.Color('#ffd11f');
    // URDF colors: printed parts are yellow, STS3215 servos are near-black.
    const isServo = color.r < 0.3 && color.g < 0.3;
    m.material = new THREE.MeshPhysicalMaterial({
      color: isServo ? new THREE.Color('#1c1f24') : new THREE.Color('#f2b632'),
      roughness: isServo ? 0.45 : 0.55,
      metalness: isServo ? 0.2 : 0,
      clearcoat: isServo ? 0.4 : 0.15,
      clearcoatRoughness: 0.5,
    });
    m.castShadow = true;
    m.receiveShadow = true;
  }
}

function styleGhost(robot: URDFRobot): void {
  const mat = new THREE.MeshStandardMaterial({
    color: '#38bdf8',
    emissive: '#0e7490',
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    roughness: 0.4,
  });
  for (const m of meshes(robot)) {
    m.material = mat;
    m.castShadow = false;
    m.renderOrder = 2;
  }
}
