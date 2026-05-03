import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';

// --- DOM ---
const videoEl = document.getElementById('webcam-video');
const handCanvas = document.getElementById('hand-canvas');
const handCtx = handCanvas.getContext('2d');
const container = document.getElementById('canvas-container');
const mindarContainer = document.getElementById('mindar-container');

const loadingScreen = document.getElementById('loading-screen');
const loadingText = document.getElementById('loading-text');
const errorOverlay = document.getElementById('error-overlay');
const gestureStatus = document.getElementById('gesture-status');
const handDot = document.getElementById('hand-dot');
const scaleValue = document.getElementById('scale-value');
const lockStatus = document.getElementById('lock-status');

const resetButton = document.getElementById('reset-button');
const skeletonToggle = document.getElementById('skeleton-toggle');
const menuToggle = document.getElementById('menu-toggle');
const uiPanel = document.getElementById('ui-panel');
const retryButton = document.getElementById('retry-button');
const modeRadios = document.querySelectorAll('input[name="ar-mode"]');
const cameraRow = document.getElementById('camera-select-row');
const cameraSelect = document.getElementById('camera-select');

// --- Constantes ---
const FIXED_DEPTH = -4;
const MIN_SCALE = 0.4;
const MAX_SCALE = 2.6;
const PALM_NEAR = 0.30;
const PALM_FAR = 0.06;
const POSITION_LERP = 0.08;
const ROTATION_LERP = 0.06;
const SCALE_LERP = 0.08;
const HAND_LOST_FRAMES = 12;
const PINCH_DROP_THRESHOLD = 0.18;

// --- Verificação de Dispositivo ---
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// --- Estado Global ---
const state = {
    mode: 'presa', // 'presa' | 'manipular' | 'imagem'
    facingMode: isMobile ? 'environment' : 'user',
    modelLoaded: false,
    cameraReady: false,
    handVisible: false,
    framesSinceHand: 0,
    gesture: 'idle',
    locked: false,
    manipulateGrabbed: false,
    showSkeleton: true,
    menuHidden: false,

    targetScale: 1,
    currentScale: 1,
    targetPosition: new THREE.Vector3(0, 0, FIXED_DEPTH),
    targetQuaternion: new THREE.Quaternion(),
};

// --- Otimização de Memória ---
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
const _quatScratch = new THREE.Quaternion();
const _baseOffsetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));

// --- Cenas AR ---
let baseScene, baseCamera, baseRenderer;
let mindarThree, mindarAnchor;
let modelRoot;
let cameraHelper;

// ==========================================
// 1. Configuração do Three.js (MediaPipe)
// ==========================================
function initBaseThree() {
    baseScene = new THREE.Scene();

    baseCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
    baseCamera.position.set(0, 0, 0);

    baseRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    baseRenderer.setSize(window.innerWidth, window.innerHeight);
    baseRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    baseRenderer.outputEncoding = THREE.sRGBEncoding;
    baseRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    baseRenderer.toneMappingExposure = 1.0;

    container.appendChild(baseRenderer.domElement);

    setupLights(baseScene);
    window.addEventListener('resize', onResize);
    onResize();
}

function setupLights(sceneObj) {
    sceneObj.add(new THREE.AmbientLight(0xffffff, 0.55));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2, 4, 3);
    sceneObj.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x88aaff, 0.6);
    fillLight.position.set(-3, 2, -2);
    sceneObj.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffaa66, 0.4);
    rimLight.position.set(0, -2, -4);
    sceneObj.add(rimLight);
}

// ==========================================
// 2. Configuração do MindAR (Image Tracking)
// ==========================================
function initMindAR() {
    // Destrói instância anterior se existir, para evitar câmeras duplicadas
    if (mindarThree) {
        try { mindarThree.stop(); } catch (_) { }
    }

    mindarThree = new MindARThree({
        container: mindarContainer,
        imageTargetSrc: 'assets/targets.mind',
        uiLoading: 'no',
        uiScanning: 'no',
        uiError: 'no',

        // filterMinCF baixo: logo estável quando o celular está parado.
        // filterBeta alto: filtro reage quase instantaneamente ao movimento
        // da câmera, dando a sensação de que a logo está "pregada" no target.
        filterMinCF: 0.001,
        filterBeta: 1000,

        // missTolerance: quantos frames o target pode sumir antes de soltar a âncora.
        // Default é 5 — muito baixo, qualquer tremor ou dedo na frente perde o target.
        // Com 30, a logo permanece ancorada durante oclusões breves e movimentos rápidos.
        missTolerance: 30,

        // warmupTolerance: frames consecutivos necessários para ancorar pela primeira vez.
        // Reduzir de 5 para 2 acelera o lock-on inicial sem comprometer a estabilidade.
        warmupTolerance: 2,

        // Garante que o MindAR use a mesma câmera selecionada no app
        webcam: { facingMode: state.facingMode },
    });

    setupLights(mindarThree.scene);
    mindarAnchor = mindarThree.addAnchor(0);
}

// ==========================================
// 3. Carregamento do Modelo
// ==========================================
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
        baseScene.add(modelRoot);

        state.modelLoaded = true;
        maybeHideLoading();
    }, undefined, (err) => {
        console.error('Erro ao carregar logo.glb:', err);
        showError('Falha ao carregar o modelo 3D (assets/logo.glb).');
    });
}

// ==========================================
// 4. Lógica de Transição
// ==========================================
async function switchMode(newMode) {
    if (state.mode === newMode) return;
    const oldMode = state.mode;
    state.mode = newMode;

    loadingText.textContent = newMode === 'imagem'
        ? 'Iniciando Rastreamento de Imagem...'
        : 'Iniciando Rastreamento de Mãos...';
    loadingScreen.style.display = 'flex';
    loadingScreen.style.opacity = '1';

    try {
        if (oldMode === 'imagem') {
            // Para o MindAR e reativa MediaPipe
            try { await mindarThree.stop(); } catch (_) { }
            mindarContainer.classList.add('hidden');

            videoEl.style.display = 'block';
            handCanvas.style.display = 'block';
            container.style.display = 'block';

            // Devolve o modelo para a cena base
            if (mindarAnchor && mindarAnchor.group.children.includes(modelRoot)) {
                mindarAnchor.group.remove(modelRoot);
            }
            baseScene.add(modelRoot);
            state.targetPosition.set(0, 0, FIXED_DEPTH);
            modelRoot.position.copy(state.targetPosition);
            modelRoot.rotation.set(0, 0, 0);
            modelRoot.quaternion.identity();

            if (cameraHelper) {
                await cameraHelper.start();
            } else {
                initMediaPipe();
            }

        } else if (newMode === 'imagem') {
            // Para MediaPipe
            if (cameraHelper) {
                cameraHelper.stop();
                const stream = videoEl.srcObject;
                if (stream) stream.getTracks().forEach(t => t.stop());
            }

            videoEl.style.display = 'none';
            handCanvas.style.display = 'none';
            container.style.display = 'none';
            state.handVisible = false;
            handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);

            mindarContainer.classList.remove('hidden');

            // Retira o modelo da cena base antes de recriar o MindAR
            if (baseScene.children.includes(modelRoot)) {
                baseScene.remove(modelRoot);
            }

            // Recria o MindAR com o facingMode corrente — garante câmera certa
            initMindAR();

            // Ancora o modelo no target.
            // O anchor.group alinha o plano XY com o target (papel plano),
            // por isso o modelo precisa rotacionar 90° no eixo X para ficar em pé.
            mindarAnchor.group.add(modelRoot);
            modelRoot.position.set(0, 0, 0);
            modelRoot.rotation.set(Math.PI / 2, 0, 0);

            await mindarThree.start();
        }

        updateUi();
    } catch (error) {
        console.error(error);
        showError('Falha ao alternar as câmeras. Recarregue a página.');
    } finally {
        setTimeout(() => {
            loadingScreen.style.opacity = '0';
            setTimeout(() => loadingScreen.style.display = 'none', 500);
        }, 800);
    }
}

// ==========================================
// Utils & MediaPipe Core
// ==========================================
function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    baseCamera.aspect = w / h;
    baseCamera.updateProjectionMatrix();
    baseRenderer.setSize(w, h);
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

function dist3(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fingerExtended(lm, tip, pip, mcp) {
    return dist3(lm[tip], lm[mcp]) > dist3(lm[pip], lm[mcp]) * 1.05;
}

function projectToWorld(nx, ny, depth) {
    _vResult.set((nx * 2) - 1, -(ny * 2) + 1, 0.5);
    _vResult.unproject(baseCamera);
    _vDir.copy(_vResult).sub(baseCamera.position).normalize();
    return _vResult.copy(baseCamera.position).add(_vDir.multiplyScalar(Math.abs(depth)));
}

function computeHandQuaternion(wlm, handednessLabel) {
    _wrist.set(-wlm[0].x, -wlm[0].y, -wlm[0].z);
    _middleMcp.set(-wlm[9].x, -wlm[9].y, -wlm[9].z);
    _indexMcp.set(-wlm[5].x, -wlm[5].y, -wlm[5].z);
    _pinkyMcp.set(-wlm[17].x, -wlm[17].y, -wlm[17].z);

    _up.subVectors(_middleMcp, _wrist).normalize();
    _right.subVectors(_indexMcp, _pinkyMcp).normalize();

    if (handednessLabel === 'Left') {
        _right.negate();
    }

    _forward.crossVectors(_right, _up).normalize();
    _right.crossVectors(_up, _forward).normalize();
    _mat4.makeBasis(_right, _up, _forward);

    // Reutiliza _quatScratch em vez de alocar new Quaternion() a cada frame
    _quatScratch.setFromRotationMatrix(_mat4);
    _quatScratch.multiply(_baseOffsetQuat);

    return _quatScratch;
}

function updateModePresa(lm, wlm, handednessLabel) {
    const palm = lm[9];

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

    if (pinchDist < PINCH_DROP_THRESHOLD) {
        state.manipulateGrabbed = true;

        const midX = (thumbTip.x + indexTip.x) / 2;
        const midY = (thumbTip.y + indexTip.y) / 2;
        state.targetPosition.copy(projectToWorld(1 - midX, midY, FIXED_DEPTH));

        const scaleFactor = pinchDist / PINCH_DROP_THRESHOLD;
        state.targetScale = THREE.MathUtils.lerp(MIN_SCALE * 0.5, MAX_SCALE * 1.5, scaleFactor);

        if (wlm && wlm.length === 21) {
            state.targetQuaternion.copy(computeHandQuaternion(wlm, handednessLabel));
        }
    } else {
        state.manipulateGrabbed = false;
    }
}

function onResults(results) {
    drawSkeleton(results);

    if (!state.modelLoaded || !modelRoot || state.mode === 'imagem') return;

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const lm = results.multiHandLandmarks[0];
        const wlm = results.multiHandWorldLandmarks?.[0];
        const handednessLabel = results.multiHandedness[0].label;

        state.handVisible = true;
        state.framesSinceHand = 0;

        if (state.mode === 'presa') {
            updateModePresa(lm, wlm, handednessLabel);
            state.gesture = state.locked ? 'fist' : 'move';
        } else if (state.mode === 'manipular') {
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
    if (!state.showSkeleton || state.mode === 'imagem') return;
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;

    const lm = results.multiHandLandmarks[0];
    const w = handCanvas.width, h = handCanvas.height;

    let color = '#4ade80';
    if (state.mode === 'presa' && state.locked) color = '#f87171';
    if (state.mode === 'manipular' && state.manipulateGrabbed) color = '#3b82f6';

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

function updateUi() {
    if (state.mode === 'imagem') {
        gestureStatus.textContent = 'Procurando Imagem...';
        gestureStatus.style.color = '#eab308';
        lockStatus.textContent = 'rastreando cena';
        handDot.classList.remove('active');
        return;
    }

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

    const g = state.gesture;
    gestureStatus.textContent = GESTURE_LABELS[g] || g;
    gestureStatus.style.color = GESTURE_COLORS[g] || '#fff';
    handDot.classList.toggle('active', state.handVisible);

    if (state.mode === 'presa') {
        lockStatus.textContent = state.locked ? 'travado' : 'livre';
    } else {
        lockStatus.textContent = state.manipulateGrabbed ? 'segurando' : 'livre';
    }
}

function updateMirrors() {
    const isUser = state.facingMode === 'user';
    videoEl.style.transform = isUser ? 'scaleX(-1)' : 'none';
    handCanvas.style.transform = isUser ? 'scaleX(-1)' : 'none';
}

async function initMediaPipe() {
    if (typeof Hands !== 'function' || typeof Camera !== 'function') {
        showError('Bibliotecas do MediaPipe não carregaram.');
        return;
    }

    const hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: state.facingMode === 'environment' ? 0.75 : 0.7,
        minTrackingConfidence: 0.85,
    });
    hands.onResults(onResults);

    cameraHelper = new Camera(videoEl, {
        onFrame: async () => {
            if (state.mode !== 'imagem') {
                await hands.send({ image: videoEl });
            }
        },
        facingMode: state.facingMode,
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
        switchMode(e.target.value);
    });
});

cameraSelect.addEventListener('change', async (e) => {
    state.facingMode = e.target.value;
    updateMirrors();

    if (state.mode === 'imagem') {
        // No modo imagem, recria o MindAR com o novo facingMode
        try { await mindarThree.stop(); } catch (_) { }
        if (mindarAnchor && modelRoot) {
            mindarAnchor.group.remove(modelRoot);
        }
        initMindAR();
        mindarAnchor.group.add(modelRoot);
        modelRoot.position.set(0, 0, 0);
        modelRoot.rotation.set(Math.PI / 2, 0, 0);
        try {
            await mindarThree.start();
        } catch (err) {
            showError('Falha ao trocar câmera no modo imagem.');
        }
    } else {
        if (cameraHelper) {
            cameraHelper.stop();
        }
        initMediaPipe();
    }
});

resetButton.addEventListener('click', () => {
    if (state.mode === 'imagem') return;

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

    if (!state.showSkeleton) {
        handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
    }
});

menuToggle.addEventListener('click', () => {
    state.menuHidden = !state.menuHidden;
    uiPanel.classList.toggle('is-hidden', state.menuHidden);
    uiPanel.inert = state.menuHidden;
    uiPanel.setAttribute('aria-hidden', String(state.menuHidden));
    menuToggle.textContent = state.menuHidden ? 'Mostrar menu' : 'Esconder menu';
    menuToggle.setAttribute('aria-expanded', String(!state.menuHidden));
});

retryButton.addEventListener('click', () => location.reload());

// --- Loop Principal ---
function animate() {
    requestAnimationFrame(animate);

    if (state.mode === 'imagem') {
        if (mindarThree && mindarThree.renderer) {
            mindarThree.renderer.render(mindarThree.scene, mindarThree.camera);
        }
        return;
    }

    if (modelRoot) {
        const canMove = (state.mode === 'presa' && !state.locked) ||
            (state.mode === 'manipular' && state.manipulateGrabbed);

        if (canMove && state.handVisible) {
            if (modelRoot.position.distanceTo(state.targetPosition) > 0.01) {
                modelRoot.position.lerp(state.targetPosition, POSITION_LERP);
            }
            if (modelRoot.quaternion.angleTo(state.targetQuaternion) > 0.02) {
                modelRoot.quaternion.slerp(state.targetQuaternion, ROTATION_LERP);
            }
        }

        if (Math.abs(state.targetScale - state.currentScale) > 0.005) {
            state.currentScale += (state.targetScale - state.currentScale) * SCALE_LERP;
            modelRoot.scale.setScalar(state.currentScale);
            scaleValue.textContent = state.currentScale.toFixed(2) + 'x';
        }
    }

    baseRenderer.render(baseScene, baseCamera);
}

// --- Boot ---
if (!isMobile) {
    if (cameraRow) cameraRow.style.display = 'none';
} else {
    if (cameraSelect) cameraSelect.value = state.facingMode;
}

updateMirrors();

initBaseThree();
initMindAR();
loadModel();
initMediaPipe();
animate();