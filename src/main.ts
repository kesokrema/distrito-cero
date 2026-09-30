import * as THREE from 'three';
import './style.css';
import { EventBus } from './core/EventBus';
import { GridSystem } from './world/GridSystem';
import { PrefabManager } from './world/PrefabManager';
import { DestructionSystem } from './world/DestructionSystem';
import { RenderEngine, type CameraMode } from './engine/RenderEngine';
import { CityClock } from './engine/CityClock';
import { CityLightSystem } from './engine/CityLightSystem';
import { LocomotionIK } from './actors/LocomotionIK';
import { NPCController } from './actors/NPCController';
import { InventorySystem } from './actors/InventorySystem';
import { ItemSystem } from './world/ItemSystem';
import { InteriorSystem } from './world/InteriorSystem';
import { CombatSystem } from './actors/CombatSystem';
import { VehicleSystem } from './actors/VehicleSystem';
import { RagdollSystem, type RagdollBody } from './actors/RagdollSystem';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div id="scene" aria-label="Ciudad voxel jugable"></div>
  <header class="hud hud-left">
    <div class="brand"><span>DISTRITO <strong>CERO</strong></span><small>CIUDAD EN MOVIMIENTO</small></div>
    <div class="health-row"><span class="heart" aria-hidden="true">♥</span><div class="health-track"><div id="health-fill"></div></div></div>
    <div class="health-label">SALUD <span id="health-value">100</span>/100 <span id="armor-label"></span></div>
    <div class="stamina-line" title="Resistencia"><div id="stamina-fill"></div></div>
    <div class="district-row"><span class="tiny-label">DISTRITO ACTUAL</span><strong id="district-name">CENTRO</strong></div>
    <div class="objective"><b>ENCARGO</b><span id="mission">Recoge suministros · 0/3</span></div>
  </header>
  <section class="hud hud-right" aria-label="Estado de la ciudad">
    <div class="stat-block panic"><span>PÁNICO</span><strong id="panic">0%</strong><div class="panic-track"><div id="panic-fill"></div></div></div>
    <div class="stat-block threat" aria-label="Enemigos cercanos"><strong id="enemies">8</strong><span>HOSTILES</span></div>
    <span id="clock-time" class="city-time" aria-label="Hora de la ciudad"></span>
  </section>
  <div class="top-center"><span class="signal"></span><span id="status">SIMULACIÓN ACTIVA</span><span class="seed" id="seed"></span><span id="floor-level" class="vehicle-speed"></span><span id="vehicle-speed" class="vehicle-speed"></span></div>
  <button id="help-button" class="help-button" aria-label="Mostrar controles" title="Controles (H)">?</button>
  <button id="camera-reset" class="camera-reset" aria-label="Centrar cámara" title="Centrar cámara (C)">⌖</button>
  <button id="ground-toggle" class="ground-toggle" aria-pressed="false" title="Ocultar suelo para comparar el rendimiento">OCULTAR SUELO</button>
  <button id="wireframe-toggle" class="wireframe-toggle" aria-pressed="false" title="Alternar malla de la escena (G)">WIREFRAME</button>
  <div class="camera-picker"><button id="camera-view" aria-label="Elegir vista de cámara" aria-expanded="false" title="Cambiar vista (V)">VISTA · ISO ▾</button><div id="camera-menu" class="camera-menu" hidden><button data-camera-mode="isometric" aria-pressed="true">ISOMÉTRICA</button><button data-camera-mode="perspective" aria-pressed="false">PERSPECTIVA 3D</button><button data-camera-mode="firstPerson" aria-pressed="false">PRIMERA PERSONA</button></div></div>
  <div class="crosshair" aria-hidden="true"></div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <div id="interaction-prompt" class="interaction-prompt"></div>
  <nav class="hotbar" aria-label="Equipo"><button id="loadout-toggle" aria-label="Mostrar equipo" title="Mostrar equipo">☷</button><button data-slot="1"><small>1</small><span>PUÑOS</span></button><button data-slot="2" class="selected"><small>2</small><span>PISTOLA</span></button><button data-slot="3"><small>3</small><span>SUBFUSIL</span></button><button data-slot="4"><small>4</small><span>ESCOPETA</span></button><button data-slot="5"><small>5</small><span>FUSIL</span></button><button data-slot="6"><small>6</small><span>BAZUCA</span></button><div class="ammo-panel"><strong id="ammo-value">12 / 36</strong><small id="medkit-value">Q · BOTIQUÍN ×1</small></div></nav>
  <footer class="bottom-bar"><span>DISTRITO CERO <b> / </b> CIUDAD ABIERTA</span><span id="mission-progress">SUMINISTROS 0/3</span></footer>
  <aside class="hud controls" aria-label="Controles">
    <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>MOVER</span></div>
    <div><kbd>MOUSE</kbd><span>MIRAR SIN CLIC / DISPARAR / CLIC DERECHO PARA APUNTAR</span></div>
    <div><kbd>1-6 / RUEDA</kbd><span>CAMBIAR ARMA</span></div>
    <div><kbd>E</kbd><span>INTERACTUAR</span><kbd>R</kbd><span>RECARGAR</span></div>
    <div><kbd>Q</kbd><span>BOTIQUÍN</span><kbd>SHIFT</kbd><span>CORRER</span></div>
    <div><kbd>SPACE</kbd><span>SALTAR</span><kbd>V</kbd><span>CÁMARA</span></div>
    <div><kbd>G</kbd><span>WIREFRAME</span></div>
  </aside>
  <div class="mobile-controls" aria-label="Controles táctiles"><div class="dpad"><button data-key="KeyW" aria-label="Arriba">▲</button><div><button data-key="KeyA" aria-label="Izquierda">◀</button><button data-key="KeyS" aria-label="Abajo">▼</button><button data-key="KeyD" aria-label="Derecha">▶</button></div></div><div class="mobile-actions"><button id="mobile-interact">E</button><button id="mobile-roll">SALTAR</button><button id="mobile-fire" class="fire-button">DISPARAR</button></div></div>
  <div id="overlay" class="overlay hidden"><div class="overlay-card"><h1 id="overlay-title">EN PAUSA</h1><p id="overlay-copy">La ciudad seguirá en movimiento cuando regreses.</p><button id="resume">CONTINUAR</button><button id="restart">NUEVA CIUDAD</button></div></div>
`;

const sceneHost = document.querySelector<HTMLElement>('#scene')!;
const events = new EventBus();
const seedFromUrl = Number(new URLSearchParams(location.search).get('seed'));
const hourFromUrl = Number(new URLSearchParams(location.search).get('time'));
const cityClock = new CityClock(Number.isFinite(hourFromUrl) && new URLSearchParams(location.search).has('time') ? hourFromUrl : undefined);
const grid = new GridSystem(seedFromUrl || undefined);
const engine = new RenderEngine(sceneHost);
engine.setTimeOfDay(cityClock);
const prefabs = new PrefabManager(engine.scene, grid, cityClock.streetActivity);
const cityLights = new CityLightSystem(engine.scene, prefabs);
const landmarkView=new URLSearchParams(location.search).get('landmark');
let landmarkReady = false;
if(landmarkView==='canal') {
  const center=grid.blockAt(grid.center,grid.center);
  prefabs.ensureAround(grid.terrain.canalColumn,center.bz,1,Infinity);
}
engine.setGroundProbe((x,z,y)=>grid.surfaces.below(x,z,y,grid.groundHeight(x,z)));
const cameraRaycaster = new THREE.Raycaster();
engine.setCollisionProbe((from, to) => {
  const direction = to.clone().sub(from);
  const distance = direction.length();
  cameraRaycaster.set(from, direction.normalize());
  cameraRaycaster.far = distance;
  const hits = cameraRaycaster.intersectObject(prefabs.buildings, true)
    .concat(cameraRaycaster.intersectObjects(prefabs.interiorMeshesNear(from.x, from.z, distance + 2), false))
    .sort((a, b) => a.distance - b.distance);
  for (const hit of hits) {
    if (!hit.object.visible || hit.object.parent?.visible === false) continue;
    if (hit.object.userData.vehicleCore) continue;
    const voxel = prefabs.voxelForHit(hit);
    if (voxel !== null && !prefabs.voxels[voxel]?.alive) continue;
    return hit.distance;
  }
  return null;
});
const destruction = new DestructionSystem(engine.scene, grid, prefabs, events);
const ragdolls = new RagdollSystem(engine.scene, grid, prefabs);
const player = new LocomotionIK(grid, engine.scene, (x, z) => prefabs.interiorWalkable(x, z), (x, z, currentY) => prefabs.stairSurface(x, z, currentY), (x, z, y) => prefabs.interiorObstacleAt(x, z, y), (x, z, level) => prefabs.upperFloorPresent(x, z, level),(x,z,level)=>prefabs.floorHeightAt(x,z,level));
const spawnCell = grid.openCells()
  .filter((cell) => cell.tile === 'sidewalk' && Math.abs(cell.x - grid.center) < 7 && Math.abs(cell.z - grid.center) < 7)
  .filter((cell) => {
    const [x, z] = grid.world(cell.x, cell.z);
    return prefabs.vehicles.every((vehicle) => Math.hypot(vehicle.position.x - x, vehicle.position.z - z) > 4);
  })
  .sort((a, b) => Math.hypot(a.x - grid.center, a.z - grid.center) - Math.hypot(b.x - grid.center, b.z - grid.center))[0];
const [spawnX, spawnZ] = grid.world(spawnCell?.x ?? grid.center + 2, spawnCell?.z ?? grid.center + 3);
player.group.position.set(spawnX, grid.groundHeight(spawnX,spawnZ), spawnZ);
const npcs = new NPCController(engine.scene, grid, events, destruction, player.group, prefabs, ragdolls, cityClock.streetActivity);
const clearSpawnCell = grid.openCells()
  .filter((cell) => cell.tile === 'sidewalk' && Math.abs(cell.x - grid.center) < 7 && Math.abs(cell.z - grid.center) < 7)
  .filter((cell) => {
    const [x, z] = grid.world(cell.x, cell.z);
    return prefabs.vehicles.every((vehicle) => Math.hypot(vehicle.position.x - x, vehicle.position.z - z) > 4) &&
      npcs.npcs.every((npc) => Math.hypot(npc.group.position.x - x, npc.group.position.z - z) > 1.6);
  })
  .sort((a, b) => Math.hypot(a.x - grid.center, a.z - grid.center) - Math.hypot(b.x - grid.center, b.z - grid.center))[0];
if (clearSpawnCell) {
  const [clearX, clearZ] = grid.world(clearSpawnCell.x, clearSpawnCell.z);
  player.group.position.set(clearX, grid.groundHeight(clearX,clearZ), clearZ);
}
if(landmarkView&&landmarkView!=='canal') {
  const wanted=landmarkView==='bridge'?'bridge':'plaza';
  const surface=[...grid.surfaces.surfaces.values()].find(s=>s.kind===wanted);
  if(surface) {
    const x=(surface.x0+surface.x1)/2,z=(surface.z0+surface.z1)/2;
    player.group.position.set(x,grid.surfaces.height(surface,x,z),z);
  }
}
player.setActorCollision((x, z) => npcs.blocksPlayerAt(x, z));
const inventory = new InventorySystem();
const items = new ItemSystem(engine.scene, grid, inventory, events);
const interiors = new InteriorSystem(prefabs, inventory, player);
const combat = new CombatSystem(engine.scene, player, inventory, npcs, destruction, prefabs, events);
const vehicles = new VehicleSystem(prefabs, grid, events, npcs, destruction);
vehicles.setStreetActivity(cityClock.streetActivity);
const clock = new THREE.Clock();
const keys = new Set<string>();
let pointerAim = new THREE.Vector3(0, 1.2, 6);
let pointerTargetIsNpc = false;
let pointerTargetHit: ReturnType<NPCController['raycast']> = null;
let aimClient: { x: number; y: number } | null = null;
let firing = false;
let queuedTapTime = 0;
let aimingDownSights = false;
let intimidationTimer = 0;
let cameraDrag: { button: number; x: number; y: number; moved: boolean } | null = null;
let freeLookPoint: { x: number; y: number } | null = null;
let fallbackMouseInside = false;
let pointerLockWarningShown = false;
const cameraTouches = new Map<number, { x: number; y: number }>();
let paused = false;
let gameOver = false;
let playerRagdoll: RagdollBody | null = null;
let playerKnockdownTime = 0;
let damageCooldown = 0;
let hudTimer = 0;
let streamingTimer = 0;
let citySimulationTimer = 0;
let toastTimer = 0;
let lastClockLabel = '';

document.querySelector('#seed')!.textContent = `SEED ${grid.seed}`;

const label: Record<string, string> = { industrial: 'INDUSTRIAL', commercial: 'COMERCIAL', residential: 'RESIDENCIAL', park: 'PARQUE CENTRAL' };
const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!;

function notify(message: string, tone: 'info' | 'danger' | 'success' = 'info'): void {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast visible ${tone}`;
  toastTimer = 3;
}

events.on('alert', ({ text, tone }) => notify(text, tone));
events.on('npcLost', ({ leader }) => { if (leader) notify('LÍDER CAÍDO · ESCUADRÓN DESORGANIZADO', 'success'); });
events.on('enemyShot', ({ fromX, fromY, fromZ, toX, toY, toZ, hit, heavy }) => {
  combat.enemyTracer(new THREE.Vector3(fromX, fromY, fromZ), new THREE.Vector3(toX, toY, toZ), hit, heavy);
  if (hit) hurtPlayer(6, 'FUEGO ENEMIGO · BUSCA COBERTURA', 1.4);
});
events.on('playerRunOver', ({ dx, dz, force }) => {
  if (gameOver || playerRagdoll || vehicles.isDriving) return;
  hurtPlayer(Math.round(22 * force), 'ATROPELLADO · RECUPÉRATE', 1.6);
  if (gameOver) return;
  playerRagdoll = ragdolls.spawn(player.group.position, player.group.rotation.y,
    new THREE.Vector3(dx * 5.5, 3.2, dz * 5.5),
    { shirt: '#21b9ad', pants: '#344a56', skin: '#e8bb94', shoes: '#243640' }, player.floorLevel, 1, 3);
  playerKnockdownTime = 1.45;
  player.group.visible = false;
});

function hurtPlayer(amount: number, message: string, recovery: number): void {
  if (damageCooldown > 0 || gameOver) return;
  const absorbed = Math.min(inventory.armor, amount);
  inventory.armor -= absorbed;
  player.health = Math.max(0, player.health - (amount - absorbed));
  damageCooldown = recovery;
  notify(message, 'danger');
  if (player.health > 0) return;
  if (!playerRagdoll) playerRagdoll = ragdolls.spawn(player.group.position, player.group.rotation.y,
    new THREE.Vector3(1.4, 2.3, 0.8), { shirt: '#21b9ad', pants: '#344a56', skin: '#e8bb94', shoes: '#243640' }, player.floorLevel);
  player.group.visible = false;
  gameOver = true;
  $('#overlay').classList.remove('hidden');
  $('#overlay-title').textContent = 'CIUDAD EN SILENCIO';
  $('#overlay-copy').textContent = 'La simulación terminó. Cada nueva ciudad cuenta una historia diferente.';
  $('#resume').style.display = 'none';
}

function pickTarget(clientX: number, clientY: number): THREE.Vector3 {
  const ground = engine.groundPoint(clientX, clientY);
  const voxelHit = engine.raycaster.intersectObject(prefabs.buildings, true).find((hit) => {
    const index = prefabs.voxelForHit(hit);
    return index !== null && prefabs.voxels[index]?.alive;
  });
  const near = player.group.position;
  const interiorHit = engine.raycaster.intersectObjects(
    prefabs.interiorMeshesNear(near.x, near.z, 18), false
  ).find((hit) => prefabs.interiorPieceForHit(hit)?.alive);
  const npcHit = npcs.raycast(engine.raycaster);
  const nearestWorld = Math.min(voxelHit?.distance ?? Infinity, interiorHit?.distance ?? Infinity);
  pointerTargetIsNpc = Boolean(npcHit && npcHit.distance < nearestWorld);
  pointerTargetHit = pointerTargetIsNpc ? npcHit : null;
  if (pointerTargetIsNpc) return npcHit!.point.clone();
  if (voxelHit && voxelHit.distance < (interiorHit?.distance ?? Infinity)) return voxelHit.point.clone();
  if (interiorHit) return interiorHit.point.clone();
  return ground?.clone() || player.group.position.clone().add(new THREE.Vector3(0, 0, 6));
}

function screenAim(clientX: number, clientY: number): THREE.Vector3 {
  if (engine.mode === 'firstPerson') {
    pointerTargetIsNpc = false;
    pointerTargetHit = null;
    return engine.camera.position.clone().addScaledVector(engine.camera.getWorldDirection(new THREE.Vector3()), 70);
  }
  // Cursor motion needs only a screen-to-ground projection. Precise scene
  // intersections are resolved once per actual shot in fireAt().
  pointerTargetIsNpc = false;
  pointerTargetHit = null;
  return engine.groundPoint(clientX, clientY)?.clone() || player.group.position.clone().add(new THREE.Vector3(0, 0, 6));
}

const cameraModes: CameraMode[] = ['isometric', 'perspective', 'firstPerson'];
function requestFirstPersonLock(): void {
  if (engine.mode !== 'firstPerson' || document.pointerLockElement === engine.renderer.domElement) return;
  const canvas = engine.renderer.domElement;
  const onUnavailable = (): void => {
    app.dataset.pointerLock = 'fallback';
    if (!pointerLockWarningShown) {
      pointerLockWarningShown = true;
      notify('ESTE NAVEGADOR NO CAPTURA EL MOUSE · ARRASTRA PARA GIRAR');
    }
  };
  if (!canvas.requestPointerLock) { onUnavailable(); return; }
  try { void Promise.resolve(canvas.requestPointerLock()).catch(onUnavailable); }
  catch { onUnavailable(); }
}
function setCameraMode(mode: CameraMode): void {
  if (mode !== 'firstPerson' && document.pointerLockElement) document.exitPointerLock();
  freeLookPoint = null;
  aimingDownSights = false;
  engine.setAiming(false);
  app.dataset.aiming = 'false';
  engine.setMode(mode, player.group.position, vehicles.heading ?? player.group.rotation.y);
  app.dataset.pointerLock = mode === 'firstPerson' ? 'pending' : 'off';
  player.setFirstPerson(mode === 'firstPerson');
  engine.setViewWeapon(inventory.weapon, mode === 'firstPerson' && !vehicles.isDriving);
  app.dataset.cameraMode = mode;
  const names: Record<CameraMode, string> = { isometric: 'ISO', perspective: '3D', firstPerson: '1ª PERSONA' };
  $('#camera-view').textContent = `VISTA · ${names[mode]} ▾`;
  $('#camera-view').setAttribute('aria-expanded', 'false');
  ($('#camera-menu') as HTMLElement).hidden = true;
  document.querySelectorAll<HTMLButtonElement>('[data-camera-mode]').forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.cameraMode === mode)));
  notify(`CÁMARA · ${mode === 'isometric' ? 'ISOMÉTRICA' : mode === 'perspective' ? 'PERSPECTIVA 3D' : 'PRIMERA PERSONA'}`);
  if (mode === 'firstPerson') requestFirstPersonLock();
}

function toggleWireframe(): void {
  const enabled = !engine.isWireframe;
  engine.setWireframe(enabled);
  const button = $('#wireframe-toggle');
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = enabled ? 'WIREFRAME · ON' : 'WIREFRAME';
}

function fireAt(target: THREE.Vector3): void {
  if (paused || gameOver) return;
  if (vehicles.isDriving) { notify('DETÉN EL VEHÍCULO PARA USAR UN ARMA'); return; }
  if ((inventory.weapon === 'pistol' || inventory.weapon === 'shotgun') && combat.readyIn > 0 && !combat.isReloading) {
    queuedTapTime = Math.max(queuedTapTime, combat.readyIn + 0.15);
    return;
  }
  queuedTapTime = 0;
  if (engine.mode !== 'firstPerson' && aimClient && combat.readyIn === 0) target = pickTarget(aimClient.x, aimClient.y);
  const message = combat.fire(target, engine.mode === 'firstPerson', aimingDownSights, pointerTargetIsNpc, pointerTargetHit);
  if (message) notify(message, message.includes('SIN ') || message.includes('CIVIL') ? 'danger' : 'success');
}

function intimidateAt(clientX: number, clientY: number): void {
  if (inventory.weapon === 'fists' || vehicles.isDriving || paused || gameOver) return;
  if (engine.mode === 'firstPerson') {
    const rect = engine.renderer.domElement.getBoundingClientRect();
    clientX = rect.left + rect.width / 2;
    clientY = rect.top + rect.height / 2;
  }
  pickTarget(clientX, clientY);
  const hit = pointerTargetHit;
  if (hit && hit.npc.group.position.distanceTo(player.group.position) < 24)
    npcs.intimidate(hit.npc, player.group.position);
}

engine.renderer.domElement.addEventListener('pointermove', (event) => {
  if (engine.mode === 'firstPerson' && document.pointerLockElement === engine.renderer.domElement) {
    if (cameraDrag && Math.hypot(event.movementX, event.movementY) > 1) cameraDrag.moved = true;
    engine.orbit(event.movementX, event.movementY);
    engine.follow(player.group.position, 0, vehicles.heading, vehicles.cameraVehicle, vehicles.steeringAngle);
    pointerAim = screenAim(0, 0);
    return;
  }
  if (event.pointerType === 'touch' && cameraTouches.has(event.pointerId)) {
    const previous = cameraTouches.get(event.pointerId)!;
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    if (cameraTouches.size === 1) engine.pan(dx, dy);
    else {
      const other = [...cameraTouches.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
        const newDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        engine.zoom((oldDistance - newDistance) * 1.8);
        engine.pan(dx * 0.5, dy * 0.5);
      }
    }
    cameraTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    return;
  }
  if (engine.mode === 'firstPerson' && event.pointerType === 'mouse') return;
  if (cameraDrag) {
    const dx = event.clientX - cameraDrag.x, dy = event.clientY - cameraDrag.y;
    if (Math.hypot(dx, dy) > 2) cameraDrag.moved = true;
    if (cameraDrag.button === 2 || engine.mode === 'firstPerson') engine.orbit(dx, dy);
    else engine.pan(dx, dy);
    cameraDrag.x = event.clientX; cameraDrag.y = event.clientY;
    if (cameraDrag.button === 2) aimClient = { x: event.clientX, y: event.clientY };
    if (engine.mode === 'firstPerson') {
      engine.follow(player.group.position, 0, vehicles.heading, vehicles.cameraVehicle, vehicles.steeringAngle);
      pointerAim = screenAim(event.clientX, event.clientY);
    }
    return;
  }
  aimClient = { x: event.clientX, y: event.clientY };
  pointerAim = screenAim(event.clientX, event.clientY);
  player.aimAt(pointerAim);
  if (engine.mode !== 'firstPerson') {
    $('.crosshair').style.left = `${event.clientX}px`;
    $('.crosshair').style.top = `${event.clientY}px`;
  }
});
// Pointer lock is unavailable in some embedded browsers. Receive movement
// across the entire game window, not only over the WebGL canvas or its HUD.
window.addEventListener('pointermove', (event) => {
  if (engine.mode !== 'firstPerson' || event.pointerType !== 'mouse' ||
      document.pointerLockElement === engine.renderer.domElement || paused) return;
  fallbackMouseInside = event.clientX >= 0 && event.clientY >= 0 &&
    event.clientX < window.innerWidth && event.clientY < window.innerHeight;
  if (!fallbackMouseInside) { freeLookPoint = null; return; }
  if (freeLookPoint) {
    const dx = THREE.MathUtils.clamp(event.clientX - freeLookPoint.x, -90, 90);
    const dy = THREE.MathUtils.clamp(event.clientY - freeLookPoint.y, -90, 90);
    engine.orbit(dx, dy);
    engine.follow(player.group.position, 0, vehicles.heading, vehicles.cameraVehicle, vehicles.steeringAngle);
    pointerAim = screenAim(0, 0);
  }
  freeLookPoint = { x: event.clientX, y: event.clientY };
});
window.addEventListener('mouseout', (event) => {
  if (!event.relatedTarget) { fallbackMouseInside = false; freeLookPoint = null; }
});
engine.renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') {
    event.preventDefault();
    engine.renderer.domElement.setPointerCapture(event.pointerId);
    cameraTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    return;
  }
  if (engine.mode === 'firstPerson') {
    event.preventDefault();
    requestFirstPersonLock();
    if (event.button === 2) {
      aimingDownSights = true; intimidationTimer = 0;
      engine.setAiming(true); app.dataset.aiming = 'true';
      intimidateAt(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;
    if (document.pointerLockElement !== engine.renderer.domElement) {
      try { engine.renderer.domElement.setPointerCapture(event.pointerId); } catch { /* Pointer lock may take over this gesture. */ }
    }
    firing = true;
    pointerAim = screenAim(0, 0);
    fireAt(pointerAim);
    return;
  }
  if (event.button === 2 || event.button === 1) {
    event.preventDefault();
    if (event.button === 2) {
      aimingDownSights = true; intimidationTimer = 0;
      aimClient = { x: event.clientX, y: event.clientY };
      intimidateAt(event.clientX, event.clientY);
    }
    cameraDrag = { button: event.button, x: event.clientX, y: event.clientY, moved: false };
    return;
  }
  if (event.button !== 0) return;
  try { engine.renderer.domElement.setPointerCapture(event.pointerId); } catch { /* Browser may own this pointer. */ }
  aimClient = { x: event.clientX, y: event.clientY };
  pointerAim = screenAim(event.clientX, event.clientY);
  firing = true;
  fireAt(pointerAim);
});
window.addEventListener('pointerup', (event) => {
  if (event.button === 0) {
    firing = false;
  }
  if (event.button === 2) { aimingDownSights = false; engine.setAiming(false); app.dataset.aiming = 'false'; }
  cameraDrag = null; cameraTouches.delete(event.pointerId);
});
window.addEventListener('pointercancel', (event) => cameraTouches.delete(event.pointerId));
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === engine.renderer.domElement) {
    app.dataset.pointerLock = 'locked';
    freeLookPoint = null;
    return;
  }
  if (engine.mode === 'firstPerson') app.dataset.pointerLock = 'fallback';
  freeLookPoint = null;
  cameraDrag = null;
  firing = false;
  aimingDownSights = false;
  engine.setAiming(false);
  app.dataset.aiming = 'false';
});
engine.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
engine.renderer.domElement.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (engine.mode === 'firstPerson') {
    const slots = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'charge'] as const;
    const current = slots.indexOf(inventory.weapon);
    const next = (current + (event.deltaY > 0 ? 1 : slots.length - 1)) % slots.length;
    selectWeapon(next + 1);
  } else engine.zoom(event.deltaY);
}, { passive: false });
engine.renderer.domElement.addEventListener('pointerenter', () => $('.crosshair').classList.add('shown'));
engine.renderer.domElement.addEventListener('pointerleave', () => { $('.crosshair').classList.remove('shown'); if (engine.mode !== 'firstPerson') freeLookPoint = null; });

function togglePause(): void {
  if (gameOver) return;
  paused = !paused;
  if (paused) { queuedTapTime = 0; firing = false; }
  $('#overlay').classList.toggle('hidden', !paused);
  $('#overlay-title').textContent = 'EN PAUSA';
  $('#overlay-copy').textContent = 'La ciudad seguirá en movimiento cuando regreses.';
  $('#status').textContent = paused ? 'SIMULACIÓN EN PAUSA' : 'SIMULACIÓN ACTIVA';
}

function calmCivilians(descend = false): void {
  if (vehicles.isDriving) { const message = vehicles.interact(player); if (message) notify(message); return; }
  const pickupMessage = player.floorLevel === 0 ? items.interact(player.group.position) : null;
  if (pickupMessage) { notify(pickupMessage, 'success'); player.setWeapon(inventory.weapon); player.animateUseItem(); return; }
  const interiorMessage = interiors.interact(player.group.position, descend);
  if (interiorMessage) { notify(interiorMessage, 'success'); player.animateUseItem(); return; }
  if (player.floorLevel > 0) { notify('BAJA CAMINANDO POR LAS ESCALERAS'); return; }
  const vehicleMessage = vehicles.interact(player);
  if (vehicleMessage) { notify(vehicleMessage, 'success'); return; }
  const negotiation = npcs.negotiate(player.group.position);
  if (negotiation === 'captured') { notify('ENEMIGO DESARMADO Y DETENIDO', 'success'); return; }
  if (negotiation === 'betrayal') { notify('FALSA RENDICIÓN · EL ENEMIGO ATACA', 'danger'); return; }
  let count = 0;
  for (const npc of npcs.npcs) {
    if (npc.kind !== 'civilian' || !npc.alive) continue;
    if (npc.group.position.distanceTo(player.group.position) < 6 && npc.panic > 0) {
      npc.panic = Math.max(0, npc.panic - 0.5); count++;
    }
  }
  notify(count ? `${count} CIVILES TRANQUILIZADOS` : 'NO HAY NADIE NI NADA CERCA PARA INTERACTUAR', count ? 'success' : 'info');
}

function regenerate(): void { location.href = `${location.pathname}?seed=${Math.floor(Math.random() * 999999)}`; }

window.addEventListener('keydown', (event) => {
  if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'Escape') {
    if (document.pointerLockElement) { document.exitPointerLock(); return; }
    if (!($('#camera-menu') as HTMLElement).hidden) {
      ($('#camera-menu') as HTMLElement).hidden = true;
      $('#camera-view').setAttribute('aria-expanded', 'false');
    } else togglePause();
  }
  if (event.code === 'KeyN') regenerate();
  if (event.code === 'KeyE' && !paused) calmCivilians(event.shiftKey);
  if (event.code === 'KeyQ' && !paused) {
    const healed = inventory.useMedkit(player.health);
    if (healed !== null) { player.health = healed; player.animateUseItem(); notify('BOTIQUÍN UTILIZADO', 'success'); }
    else notify('NO PUEDES USAR UN BOTIQUÍN AHORA');
  }
  if (event.code === 'KeyR' && !paused) notify(combat.startReload() ? 'RECARGANDO…' : 'NO HAY MUNICIÓN QUE RECARGAR');
  if (event.code === 'Space' && !paused && !vehicles.isDriving) player.jump();
  if (event.code === 'Tab') $('.hotbar').classList.toggle('open');
  if (event.code === 'KeyH') $('.controls').classList.toggle('open');
  if (event.code === 'KeyC') engine.resetCamera(vehicles.heading ?? player.group.rotation.y);
  if (event.code === 'KeyV') setCameraMode(cameraModes[(cameraModes.indexOf(engine.mode) + 1) % cameraModes.length]);
  if (event.code === 'KeyG' && !event.repeat) toggleWireframe();
  if (/^Digit[1-6]$/.test(event.code)) selectWeapon(Number(event.code.slice(-1)));
});
window.addEventListener('keyup', (event) => keys.delete(event.code));
window.addEventListener('blur', () => { keys.clear(); firing = false; queuedTapTime = 0; aimingDownSights = false; engine.setAiming(false); app.dataset.aiming = 'false'; });
$('#help-button').addEventListener('click', () => $('.controls').classList.toggle('open'));
$('#camera-reset').addEventListener('click', () => engine.resetCamera(vehicles.heading ?? player.group.rotation.y));
$('#camera-view').addEventListener('click', () => {
  const menu = $('#camera-menu') as HTMLElement;
  menu.hidden = !menu.hidden;
  $('#camera-view').setAttribute('aria-expanded', String(!menu.hidden));
});
document.querySelectorAll<HTMLButtonElement>('[data-camera-mode]').forEach((button) => button.addEventListener('click', () => setCameraMode(button.dataset.cameraMode as CameraMode)));
$('#ground-toggle').addEventListener('click', () => {
  const visible = prefabs.toggleGround();
  const button = $('#ground-toggle');
  button.textContent = visible ? 'OCULTAR SUELO' : 'MOSTRAR SUELO';
  button.setAttribute('aria-pressed', String(!visible));
  button.title = visible ? 'Ocultar suelo para comparar el rendimiento' : 'Mostrar suelo de nuevo';
});
$('#wireframe-toggle').addEventListener('click', toggleWireframe);
$('#loadout-toggle').addEventListener('click', () => $('.hotbar').classList.toggle('open'));
$('#resume').addEventListener('click', () => togglePause());
$('#restart').addEventListener('click', regenerate);
function selectWeapon(slot: number): void {
  const weapon = inventory.select(slot);
  if (!weapon) { notify('ARMA NO DISPONIBLE · EXPLORA LA CIUDAD'); return; }
  queuedTapTime = 0;
  player.setWeapon(weapon);
  engine.setViewWeapon(weapon, !vehicles.isDriving);
  $('.hotbar').classList.remove('open');
  notify(({ fists: 'PUÑOS', pistol: 'PISTOLA', smg: 'SUBFUSIL', shotgun: 'ESCOPETA', rifle: 'FUSIL', charge: 'BAZUCA' })[weapon]);
}
document.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((button) => button.addEventListener('click', () => selectWeapon(Number(button.dataset.slot))));
const mobileAim = () => {
  aimClient = null;
  if (engine.mode !== 'isometric') return screenAim(0, 0);
  pointerTargetIsNpc = false;
  pointerTargetHit = null;
  return player.group.position.clone().add(new THREE.Vector3(Math.sin(player.group.rotation.y) * 9, 1.2, Math.cos(player.group.rotation.y) * 9));
};
$('#mobile-fire').addEventListener('pointerdown', (event) => { event.preventDefault(); firing = true; pointerAim = mobileAim(); fireAt(pointerAim); });
$('#mobile-fire').addEventListener('pointerup', () => { firing = false; });
$('#mobile-interact').addEventListener('click', () => calmCivilians());
$('#mobile-roll').addEventListener('pointerdown', () => { keys.add('Space'); if (!vehicles.isDriving) player.jump(); });
$('#mobile-roll').addEventListener('pointerup', () => keys.delete('Space'));
document.querySelectorAll<HTMLButtonElement>('[data-key]').forEach((button) => {
  const key = button.dataset.key!;
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); keys.add(key); });
  button.addEventListener('pointerup', () => keys.delete(key));
  button.addEventListener('pointercancel', () => keys.delete(key));
});

function updateHud(dt: number): void {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.17;
  const cell = grid.cellAtWorld(player.group.position.x, player.group.position.z);
  $('#district-name').textContent = cell ? label[cell.district] : 'EXTRARRADIO';
  $('#enemies').textContent = String(npcs.enemies);
  $('#panic').textContent = `${npcs.panic}%`;
  $('#panic-fill').style.width = `${npcs.panic}%`;
  $('#health-value').textContent = String(Math.ceil(player.health));
  $('#health-fill').style.width = `${player.health}%`;
  $('#stamina-fill').style.width = `${player.stamina}%`;
  $('#armor-label').textContent = inventory.armor > 0 ? `· CHALECO ${inventory.armor}` : '';
  $('#ammo-value').textContent = combat.isReloading ? 'RECARGANDO' : inventory.ammoLabel;
  $('#medkit-value').textContent = `Q · BOTIQUÍN ×${inventory.medkits}`;
  $('#mission').textContent = inventory.delivered ? 'Refugio abastecido · Encargo completo' : inventory.supplies >= 3 ? 'Entrega las cajas en el refugio del parque' : `Recoge suministros · ${inventory.supplies}/3`;
  $('#mission-progress').textContent = inventory.delivered ? 'ENCARGO COMPLETADO' : `SUMINISTROS ${inventory.supplies}/3`;
  $('#interaction-prompt').textContent = vehicles.isDriving ? vehicles.prompt(player.group.position) || '' : player.floorLevel > 0 ? interiors.prompt(player.group.position) || '' : items.prompt(player.group.position) || interiors.prompt(player.group.position) || vehicles.prompt(player.group.position) || '';
  $('#vehicle-speed').textContent = vehicles.isDriving ? `VEHÍCULO ${vehicles.speedKmh} KM/H` : '';
  $('#floor-level').textContent = player.floorLevel ? `PISO ${player.floorLevel + 1}` : '';
  $('#mobile-roll').textContent = vehicles.isDriving ? 'FRENAR' : 'SALTAR';
  const weaponSlots = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'charge'] as const;
  document.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((button, index) => {
    button.classList.toggle('selected', inventory.weapon === weaponSlots[index]);
    button.classList.toggle('locked', !inventory.unlocked.has(weaponSlots[index]));
  });
  $('#mobile-fire').textContent = inventory.weapon === 'fists' ? 'GOLPEAR' : inventory.weapon === 'charge' ? 'LANZAR' : 'DISPARAR';
}

function frame(): void {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(0.05, clock.getDelta());
  if (!paused && !gameOver) {
    cityClock.update(dt);
    prefabs.setStreetActivity(cityClock.streetActivity);
    npcs.setStreetActivity(cityClock.streetActivity);
    vehicles.setStreetActivity(cityClock.streetActivity);
  }
  engine.setTimeOfDay(cityClock);
  if (cityClock.label !== lastClockLabel) {
    lastClockLabel = cityClock.label;
    document.querySelector('#clock-time')!.textContent = lastClockLabel;
  }
  if (!paused) ragdolls.update(dt, (x, z) => prefabs.isWorldActive(x, z) ||
    Math.hypot(x - player.group.position.x, z - player.group.position.z) < 18);
  if (!paused && !gameOver) {
    damageCooldown = Math.max(0, damageCooldown - dt);
    streamingTimer -= dt;
    if (streamingTimer <= 0) {
      streamingTimer = 0.05;
      const generated = prefabs.ensureCameraVisible(engine.camera, player.group.position, vehicles.isDriving ? 2 : 1);
      if (generated.length) {
        const changedCells: number[] = [];
        for (const bounds of generated) for (let z = bounds.z0; z < bounds.z1; z++) for (let x = bounds.x0; x < bounds.x1; x++) changedCells.push(grid.index(x, z));
        events.emit('terrainChanged', { cells: changedCells });
        generated.forEach((bounds) => npcs.populateBlock(bounds));
      }
    }
    if(landmarkView==='canal'&&!landmarkReady) {
      const access=[...grid.surfaces.surfaces.values()].find(s=>s.id.startsWith('riverwalk:')&&s.id.endsWith(':access'));
      if(access) {
        const x=(access.x0+access.x1)/2,z=access.z0+(access.z1-access.z0)*.72;
        player.group.position.set(x,grid.surfaces.height(access,x,z),z);
        landmarkReady=true;
      }
    }
    citySimulationTimer += dt;
    const cityDt = citySimulationTimer >= 1 / 30 ? citySimulationTimer : 0;
    if (cityDt) {
      citySimulationTimer = 0;
      vehicles.updateTraffic(cityDt, player);
    }
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const input = engine.movementVector(forward, right);
    if (playerRagdoll && playerKnockdownTime > 0) {
      playerKnockdownTime = Math.max(0, playerKnockdownTime - dt);
      const pelvis = ragdolls.pelvis(playerRagdoll);
      player.group.position.set(pelvis.x, prefabs.supportHeight(pelvis.x,pelvis.z,pelvis.y), pelvis.z);
      if (playerKnockdownTime === 0) {
        ragdolls.remove(playerRagdoll);
        playerRagdoll = null;
        player.group.visible = true;
      }
    } else if (vehicles.isDriving) vehicles.update(dt, { forward: keys.has('KeyW') || keys.has('ArrowUp'), reverse: keys.has('KeyS') || keys.has('ArrowDown'), left: keys.has('KeyA') || keys.has('ArrowLeft'), right: keys.has('KeyD') || keys.has('ArrowRight'), handbrake: keys.has('Space') }, player, engine.movementVector(0, 1));
    else player.update(dt, input, destruction.colliders, keys.has('ShiftLeft') || keys.has('ShiftRight'));
    if (engine.mode === 'firstPerson' && document.pointerLockElement !== engine.renderer.domElement &&
        fallbackMouseInside && freeLookPoint) {
      const margin = 42;
      const edgeX = freeLookPoint.x < margin ? (freeLookPoint.x - margin) / margin :
        freeLookPoint.x > window.innerWidth - margin ? (freeLookPoint.x - (window.innerWidth - margin)) / margin : 0;
      const edgeY = freeLookPoint.y < margin ? (freeLookPoint.y - margin) / margin :
        freeLookPoint.y > window.innerHeight - margin ? (freeLookPoint.y - (window.innerHeight - margin)) / margin : 0;
      if (edgeX || edgeY) engine.orbit(edgeX * dt * 175, edgeY * dt * 130);
    }
    if (engine.mode === 'firstPerson') {
      pointerAim = screenAim(0, 0);
      if (!vehicles.isDriving) player.aimAt(pointerAim);
    }
    if (firing && (inventory.weapon === 'smg' || inventory.weapon === 'rifle')) fireAt(pointerAim);
    destruction.update(dt, engine.camera);
    prefabs.updateWater(dt);
    interiors.update();
    combat.update(dt);
    if (queuedTapTime > 0) {
      queuedTapTime = Math.max(0, queuedTapTime - dt);
      if (queuedTapTime > 0 && combat.readyIn === 0 && !combat.isReloading) {
        if (engine.mode === 'firstPerson') pointerAim = screenAim(0, 0);
        fireAt(pointerAim);
      }
    }
    items.update(dt, (x, z) => prefabs.isWorldActive(x, z));
    if (cityDt) npcs.update(cityDt);
    if (damageCooldown === 0) {
      const nearby = npcs.npcs.some((npc) => npc.alive && npc.kind === 'enemy' && (npc.state === 'chase' || npc.state === 'cover' || npc.state === 'flank') && npc.group.position.distanceTo(player.group.position) < 2.1);
      if (nearby && !vehicles.isDriving) hurtPlayer(5, 'ENEMIGO CERCA · RUEDA O CONTRAATACA', 2.5);
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('#toast').classList.remove('visible'); }
    engine.follow(player.group.position, dt, vehicles.heading, vehicles.cameraVehicle, vehicles.steeringAngle);
    cityLights.update(dt, player.group.position, cityClock);
    if (aimingDownSights) {
      intimidationTimer -= dt;
      if (intimidationTimer <= 0) {
        intimidationTimer = 0.24;
        if (engine.mode === 'firstPerson') intimidateAt(0, 0);
        else if (aimClient) intimidateAt(aimClient.x, aimClient.y);
      }
    }
    npcs.orientFaces(engine.camera.position, engine.mode === 'isometric', dt);
    engine.setViewWeapon(inventory.weapon, !vehicles.isDriving && !playerRagdoll && !gameOver);
    engine.updateViewWeapon(dt, player.velocity.length(), player.recoil);
    prefabs.flushFarMeshes();
    updateHud(dt);
  }
  engine.render();
}

frame();

window.addEventListener('beforeunload', () => { npcs.dispose(); prefabs.dispose(); engine.dispose(); });
