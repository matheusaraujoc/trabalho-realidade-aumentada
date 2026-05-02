import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- DOM ---
const videoEl = document.getElementById('webcam-video');
const handCanvas = document.getElementById('hand-canvas');
const handCtx = handCanvas.getContext('2d');
const container = document.getElementById('canvas-container');
const loadingScreen = document.getElementById('loading-screen');
const errorOverlay = document.getElementById('error-overlay');
const gestureStatus = document.getElementById('gesture-status');
const handDot = document.getElementById('hand-dot');
const scaleValue = document.getElementById('scale-value');
const lockStatus = document.getElementById('lock-status');
const resetButton = document.getElementById('reset-button');
const skeletonToggle = document.getElementById('skeleton-toggle');
const retryButton = document.getElementById('retry-button');
const modeRadios = document.querySelectorAll('input[name="ar-mode"]');

// --- Constantes de mapeamento ---
const FIXED_DEPTH = -4;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.6;
const PALM_NEAR = 0.30;
const PALM_FAR = 0.06;
const POSITION_LERP = 0.22;
const ROTATION_LERP = 0.20;
const SCALE_LERP = 0.18;
const HAND_LOST_FRAMES = 12;

// Limite de distância entre polegar e indicador para o modo "Manipular"
// Se a distância for menor que isso, a logo é pega. Acima disso, é solta.
const PINCH_DROP_THRESHOLD = 0.18;

// --- Estado ---
const state = {
    mode: 'presa', // 'presa' | 'manipular'
    modelLoaded: false,
    cameraReady: false,
    handVisible: false,
    framesSinceHand: 0,
    gesture: 'idle',
    locked: false, // Usado no modo 'presa' (punho fechado)
    manipulateGrabbed: false, // Usado no modo 'manipular'
    showSkeleton: true,

    targetScale: 1,
    currentScale: 1,
    targetPosition: new THREE.Vector3(0, 0, FIXED_DEPTH),
    targetQuaternion: new THREE.Quaternion(),
};

// --- Otimização de Memória (Garbage Collection) ---
// Instanciar vetores globalmente impede que o navegador crie lixo de memória a cada frame
const _vResult = new THREE.Vector3();
const _vDir = new THREE.Vector3();
const _wrist = new THREE.Vector3();
const _middleMcp = new THREE.Vector3();
const _indexMcp = new THREE.Vector3();
const _pinkyMcp = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
// Opcional: Se a logo importar deitada por padrão, altere este Euler.
const _baseOffsetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));

// --- Three.js ---
let scene, camera, renderer, modelRoot;

function initThree() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2, 4, 3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 20;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x88aaff, 0.6);
    fillLight.position.set(-3, 2, -2);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffaa66, 0.4);
    rimLight.position.set(0, -2, -4);
    scene.add(rimLight);

    loadModel();

    window.addEventListener('resize', onResize);
    onResize();
    animate();
}

function loadModel() {
    const loader = new GLTFLoader();
    loader.load('assets/logo.glb', (gltf) => {
        const inner = gltf.scene;

        const box = new THREE.Box3().setFromObject(inner);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const fit = 1.6 / maxDim;
        inner.position.sub(center);
        inner.scale.setScalar(fit);

        modelRoot = new THREE.Group();
        modelRoot.add(inner);
        modelRoot.position.copy(state.targetPosition);
        scene.add(modelRoot);

        modelRoot.traverse((node) => {
            if (node.isMesh) {
                node.castShadow = true;
                node.receiveShadow = true;
            }
        });

        state.modelLoaded = true;
        maybeHideLoading();
    }, undefined, (err) => {
        console.error('Erro ao carregar logo.glb:', err);
        showError('Falha ao carregar o modelo 3D (assets/logo.glb).');
    });
}

function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    handCanvas.width = w;
    handCanvas.height = h;
}

function maybeHideLoading() {
    if (state.modelLoaded && state.cameraReady) {
        loadingScreen.style.opacity = '0';
        setTimeout(() => { loadingScreen.style.display = 'none'; }, 500);
    }
}

function showError(msg) {
    loadingScreen.style.display = 'none';
    errorOverlay.querySelector('.error-message').textContent = msg;
    errorOverlay.hidden = false;
}

// --- Helpers de geometria ---

function dist3(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fingerExtended(lm, tip, pip, mcp) {
    return dist3(lm[tip], lm[mcp]) > dist3(lm[pip], lm[mcp]) * 1.05;
}

// Projeta posição 2D para 3D reutilizando vetores
function projectToWorld(nx, ny, depth) {
    _vResult.set((nx * 2) - 1, -(ny * 2) + 1, 0.5);
    _vResult.unproject(camera);
    _vDir.copy(_vResult).sub(camera.position).normalize();
    return _vResult.copy(camera.position).add(_vDir.multiplyScalar(Math.abs(depth)));
}

// Cálculo ABSOLUTO do Quaternion (Resolve o bug de "Deitar" e "Inverter" de mão)
function computeHandQuaternion(wlm, handednessLabel) {
    // Invertemos para casar com a câmera espelhada e sistema destro do Three
    _wrist.set(-wlm[0].x, -wlm[0].y, -wlm[0].z);
    _middleMcp.set(-wlm[9].x, -wlm[9].y, -wlm[9].z);
    _indexMcp.set(-wlm[5].x, -wlm[5].y, -wlm[5].z);
    _pinkyMcp.set(-wlm[17].x, -wlm[17].y, -wlm[17].z);

    // Eixo Y (Cima)
    _up.subVectors(_middleMcp, _wrist).normalize();

    // Eixo X (Direita)
    _right.subVectors(_indexMcp, _pinkyMcp).normalize();

    // Correção de Mão (Resolve o Bug de Inverter a Logo quando troca de mão)
    // Se o mediapipe acusa "Left" (o que visualmente é a mão Direita no espelho),
    // o vetor Index->Pinky aponta para o lado oposto. Invertemos para corrigir.
    if (handednessLabel === 'Left') {
        _right.negate();
    }

    // Eixo Z (Frente) = Direita X Cima
    _forward.crossVectors(_right, _up).normalize();

    // Reortogonaliza a Direita para garantir 90 graus perfeitos
    _right.crossVectors(_up, _forward).normalize();

    _mat4.makeBasis(_right, _up, _forward);

    const q = new THREE.Quaternion().setFromRotationMatrix(_mat4);
    // Aplica o offset base caso o modelo precise (Geralmente 0,0,0)
    q.multiply(_baseOffsetQuat);

    return q;
}

// --- Atualização por Modo ---

function updateModePresa(lm, wlm, handednessLabel) {
    const palm = lm[9];

    // Verifica Punho
    const indexExt = fingerExtended(lm, 8, 6, 5);
    const middleExt = fingerExtended(lm, 12, 10, 9);
    const ringExt = fingerExtended(lm, 16, 14, 13);
    const pinkyExt = fingerExtended(lm, 20, 18, 17);
    const isFist = (indexExt + middleExt + ringExt + pinkyExt) === 0;

    state.locked = isFist;

    if (!isFist) {
        state.targetPosition.copy(projectToWorld(1 - palm.x, palm.y, FIXED_DEPTH));

        const palmWidth = dist3(lm[5], lm[17]);
        const t = THREE.MathUtils.clamp((palmWidth - PALM_FAR) / (PALM_NEAR - PALM_FAR), 0, 1);
        state.targetScale = THREE.MathUtils.lerp(MIN_SCALE, MAX_SCALE, t);

        if (wlm && wlm.length === 21) {
            state.targetQuaternion.copy(computeHandQuaternion(wlm, handednessLabel));
        }
    }
}

function updateModeManipular(lm, wlm, handednessLabel) {
    const thumbTip = lm[4];
    const indexTip = lm[8];
    const pinchDist = dist3(thumbTip, indexTip);

    // Se os dedos estão próximos, a logo está "Pega"
    if (pinchDist < PINCH_DROP_THRESHOLD) {
        state.manipulateGrabbed = true;

        // A posição passa a ser o MEIO entre o polegar e o indicador
        const midX = (thumbTip.x + indexTip.x) / 2;
        const midY = (thumbTip.y + indexTip.y) / 2;
        state.targetPosition.copy(projectToWorld(1 - midX, midY, FIXED_DEPTH));

        // A ESCALA é dada diretamente pela distância dos dedos (Pinça abre e fecha)
        const scaleFactor = pinchDist / PINCH_DROP_THRESHOLD; // 0.0 a 1.0
        // Mapeia para limites seguros
        state.targetScale = THREE.MathUtils.lerp(MIN_SCALE * 0.5, MAX_SCALE * 1.5, scaleFactor);

        if (wlm && wlm.length === 21) {
            state.targetQuaternion.copy(computeHandQuaternion(wlm, handednessLabel));
        }
    } else {
        // Se abriu a mão muito, "Solta" a logo
        state.manipulateGrabbed = false;
    }
}

// --- Resultados MediaPipe ---

function onResults(results) {
    drawSkeleton(results);

    if (!state.modelLoaded || !modelRoot) return;

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const lm = results.multiHandLandmarks[0];
        const wlm = results.multiHandWorldLandmarks?.[0];
        const handednessLabel = results.multiHandedness[0].label; // 'Left' ou 'Right'

        state.handVisible = true;
        state.framesSinceHand = 0;

        if (state.mode === 'presa') {
            updateModePresa(lm, wlm, handednessLabel);
            state.gesture = state.locked ? 'fist' : 'move';
        } else {
            updateModeManipular(lm, wlm, handednessLabel);
            state.gesture = state.manipulateGrabbed ? 'grabbed' : 'dropped';
        }

        updateUi();
    } else {
        state.framesSinceHand++;
        if (state.framesSinceHand > HAND_LOST_FRAMES && state.handVisible) {
            state.handVisible = false;
            state.gesture = 'idle';
            state.locked = false;
            state.manipulateGrabbed = false;
            updateUi();
        }
    }
}

// --- Esqueleto (canvas overlay) ---

const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
];

function drawSkeleton(results) {
    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
    if (!state.showSkeleton) return;
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;

    const lm = results.multiHandLandmarks[0];
    const w = handCanvas.width, h = handCanvas.height;

    let color = '#4ade80';
    if (state.mode === 'presa' && state.locked) color = '#f87171';
    if (state.mode === 'manipular' && state.manipulateGrabbed) color = '#3b82f6'; // Azul quando pego

    handCtx.strokeStyle = color;
    handCtx.lineWidth = 3;
    handCtx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
        handCtx.moveTo(lm[a].x * w, lm[a].y * h);
        handCtx.lineTo(lm[b].x * w, lm[b].y * h);
    }
    handCtx.stroke();

    handCtx.fillStyle = '#fff';
    for (const p of lm) {
        handCtx.beginPath();
        handCtx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
        handCtx.fill();
    }
}

// --- HUD ---

const GESTURE_LABELS = {
    idle: 'Aguardando mão...',
    move: 'Preso na mão',
    fist: 'Travado no ar',
    grabbed: 'Pinça: Movendo/Zoom',
    dropped: 'Solto no ar'
};
const GESTURE_COLORS = {
    idle: '#94a3b8',
    move: '#4ade80',
    fist: '#f87171',
    grabbed: '#3b82f6',
    dropped: '#94a3b8'
};

function updateUi() {
    const g = state.gesture;
    gestureStatus.textContent = GESTURE_LABELS[g] || g;
    gestureStatus.style.color = GESTURE_COLORS[g] || '#fff';
    handDot.classList.toggle('active', state.handVisible);

    if (state.mode === 'presa') {
        lockStatus.textContent = state.locked ? 'travado' : 'livindo';
    } else {
        lockStatus.textContent = state.manipulateGrabbed ? 'segurando' : 'livre';
    }
}

// --- Câmera + MediaPipe ---

let cameraHelper;

async function initMediaPipe() {
    if (typeof Hands !== 'function' || typeof Camera !== 'function') {
        showError('Bibliotecas do MediaPipe não carregaram. Verifique a conexão.');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: 'user' },
            audio: false,
        });
        stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
        showError('Permissão da câmera negada ou nenhuma disponível.');
        return;
    }

    const hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7,
    });
    hands.onResults(onResults);

    cameraHelper = new Camera(videoEl, {
        onFrame: async () => { await hands.send({ image: videoEl }); },
        width: 1280,
        height: 720,
    });

    try {
        await cameraHelper.start();
        state.cameraReady = true;
        maybeHideLoading();
    } catch (err) {
        showError('Não foi possível iniciar a câmera.');
    }
}

// --- Event Listeners ---

modeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        state.mode = e.target.value;
        state.locked = false;
        state.manipulateGrabbed = false;
        updateUi();
    });
});

resetButton.addEventListener('click', () => {
    state.targetPosition.set(0, 0, FIXED_DEPTH);
    state.targetQuaternion.identity();
    state.targetScale = 1;
    if (modelRoot && !state.handVisible) {
        modelRoot.position.copy(state.targetPosition);
        modelRoot.quaternion.copy(state.targetQuaternion);
    }
});

skeletonToggle.addEventListener('click', () => {
    state.showSkeleton = !state.showSkeleton;
    skeletonToggle.textContent = state.showSkeleton ? 'Esconder esqueleto' : 'Mostrar esqueleto';
    skeletonToggle.setAttribute('aria-pressed', String(state.showSkeleton));
    if (!state.showSkeleton) handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
});

retryButton.addEventListener('click', () => location.reload());

// --- Loop ---

function animate() {
    requestAnimationFrame(animate);

    if (modelRoot) {
        // Se estiver no modo presa e solto, OU manipular e agarrado: Movimenta
        const canMove = (state.mode === 'presa' && !state.locked) ||
            (state.mode === 'manipular' && state.manipulateGrabbed);

        if (canMove && state.handVisible) {
            modelRoot.position.lerp(state.targetPosition, POSITION_LERP);
            modelRoot.quaternion.slerp(state.targetQuaternion, ROTATION_LERP);
        }

        state.currentScale += (state.targetScale - state.currentScale) * SCALE_LERP;
        modelRoot.scale.setScalar(state.currentScale);
        scaleValue.textContent = state.currentScale.toFixed(2) + 'x';
    }

    renderer.render(scene, camera);
}

// --- Boot ---
initThree();
initMediaPipe();