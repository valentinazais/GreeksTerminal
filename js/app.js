// --- WASM Helpers ---
const BARRIER_TYPE_MAP = { 'None': 0, 'UpIn': 1, 'UpOut': 2, 'DownIn': 3, 'DownOut': 4 };
const METRIC_INDICES = { price: 0, delta: 1, gamma: 2, theta: 3, vega: 4, rho: 5, payoff: 6, speed: 7, zomma: 8, color: 9, ultima: 10, vanna: 11, volga: 12 };
const SEC_VAR_INDICES = { timeToMaturity: 0, volatility: 1, riskFreeRate: 2, dividendYield: 3 };

// Pack legs into a flat Float64Array for WASM (10 doubles per leg)
function packLegsForWasm(legs, global) {
    const arr = new Float64Array(legs.length * 10);
    legs.forEach((leg, i) => {
        const off = i * 10;
        arr[off + 0] = leg.type === 'Call' ? 0 : 1;
        arr[off + 1] = leg.position === 'Long' ? 0 : 1;
        arr[off + 2] = leg.strike;
        arr[off + 3] = global.t;
        arr[off + 4] = global.v;
        arr[off + 5] = global.r;
        arr[off + 6] = global.q;
        arr[off + 7] = leg.quantity;
        arr[off + 8] = BARRIER_TYPE_MAP[leg.barrierType] || 0;
        arr[off + 9] = leg.barrierLevel || 0;
    });
    return arr;
}

// Allocate packed leg data in WASM heap, returns pointer
function allocLegsInWasm(packedLegs) {
    const nBytes = packedLegs.length * 8; // Float64
    const ptr = Module._malloc(nBytes);
    Module.HEAPF64.set(packedLegs, ptr / 8);
    return ptr;
}

// --- App State ---
const STATE = {
    legs: [
        {
            id: generateId(),
            type: 'Call',
            position: 'Long',
            strike: 100,
            quantity: 1,
            barrierType: 'None',
            barrierLevel: 0
        }
    ],
    global: {
        minPrice: 50,
        maxPrice: 150,
        steps: 100,
        t: 1.0,
        r: 0.05,
        q: 0.0,
        v: 0.20
    },
    activeMetrics: ['payoff'],
    chartData: null,
    isAnimating: false,
    wasmReady: false
};

// --- DOM Elements ---
const elLegsContainer = document.getElementById('legs-container');
const elLegCount = document.getElementById('leg-count-badge');
const btnAddLeg = document.getElementById('add-leg-btn');

const elMinPrice = document.getElementById('global-min-price');
const elMinPriceRange = document.getElementById('global-min-price-range');
const elMaxPrice = document.getElementById('global-max-price');
const elMaxPriceRange = document.getElementById('global-max-price-range');
const elTInput = document.getElementById('global-t');
const elTRange = document.getElementById('global-t-range');
const elRInput = document.getElementById('global-r');
const elRRange = document.getElementById('global-r-range');
const elQInput = document.getElementById('global-q');
const elQRange = document.getElementById('global-q-range');
const elVInput = document.getElementById('global-v');
const elVRange = document.getElementById('global-v-range');

const elNewType = document.getElementById('new-leg-type');
const elNewPos = document.getElementById('new-leg-position');
const elNewStrike = document.getElementById('new-leg-strike');
const elNewStrikeRange = document.getElementById('new-leg-strike-range');
const elNewBarrierType = document.getElementById('new-leg-barrier-type');
const elNewBarrier = document.getElementById('new-leg-barrier');
const elNewBarrierRange = document.getElementById('new-leg-barrier-range');
const elBarrierLevelCell = document.querySelector('.barrier-level-cell');

const toggleCheckboxes = document.querySelectorAll('.metric-toggle input[type="checkbox"]');

let chart = null;

const METRIC_CONFIG = {
    payoff: { color: '#ffffff', label: 'PAYOFF' },
    price: { color: '#00ffcc', label: 'PRICE' },
    delta: { color: '#33ff33', label: 'DELTA' },
    gamma: { color: '#cc33ff', label: 'GAMMA' },
    vega: { color: '#ffcc00', label: 'VEGA' },
    theta: { color: '#ff3333', label: 'THETA' },
    rho: { color: '#00ccff', label: 'RHO' },
    speed: { color: '#ffaa00', label: 'SPEED' },
    zomma: { color: '#00aaff', label: 'ZOMMA' },
    color: { color: '#ff00aa', label: 'COLOR' },
    ultima: { color: '#aaff00', label: 'ULTIMA' },
    vanna: { color: '#ff6600', label: 'VANNA' },
    volga: { color: '#aa00ff', label: 'VOLGA' }
};

const BARRIER_LABELS = {
    'None': '',
    'UpIn': '↑IN',
    'UpOut': '↑OUT',
    'DownIn': '↓IN',
    'DownOut': '↓OUT'
};

// --- Utilities ---
function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

let timeoutId;
function debouncedCompute(delay = 50) {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => computeGreeks(), delay);
}

// --- Initialization & Binding ---
function bindUIElements() {
    const bindSyncedInput = (numEl, rangeEl, stateKey, isPercent = false) => {
        const updateState = (val) => {
            if (isNaN(val)) return;
            STATE.global[stateKey] = isPercent ? val / 100 : val;
            debouncedCompute();
        };

        numEl.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            if (!isNaN(val)) rangeEl.value = val;
            updateState(val);
        });

        rangeEl.addEventListener('input', (e) => {
            let val = parseFloat(e.target.value);
            if (!isNaN(val)) numEl.value = val;
            updateState(val);
        });
    };

    bindSyncedInput(elMinPrice, elMinPriceRange, 'minPrice');
    bindSyncedInput(elMaxPrice, elMaxPriceRange, 'maxPrice');
    bindSyncedInput(elTInput, elTRange, 't');
    bindSyncedInput(elRInput, elRRange, 'r', true);
    bindSyncedInput(elQInput, elQRange, 'q', true);
    bindSyncedInput(elVInput, elVRange, 'v', true);

    elNewStrike.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (!isNaN(val)) elNewStrikeRange.value = val;
    });
    elNewStrikeRange.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (!isNaN(val)) elNewStrike.value = val;
    });

    elNewBarrier.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (!isNaN(val)) elNewBarrierRange.value = val;
    });
    elNewBarrierRange.addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        if (!isNaN(val)) elNewBarrier.value = val;
    });

    elNewBarrierType.addEventListener('change', (e) => {
        elBarrierLevelCell.style.display = e.target.value === 'None' ? 'none' : 'flex';
    });

    STATE.global.minPrice = parseFloat(elMinPrice.value) || 50;
    STATE.global.maxPrice = parseFloat(elMaxPrice.value) || 150;
    STATE.global.t = parseFloat(elTInput.value) || 1.0;
    STATE.global.r = (parseFloat(elRInput.value) || 5.0) / 100;
    STATE.global.q = (parseFloat(elQInput.value) || 0.0) / 100;
    STATE.global.v = (parseFloat(elVInput.value) || 20.0) / 100;

    toggleCheckboxes.forEach(cb => {
        cb.addEventListener('change', (e) => {
            const metric = e.target.getAttribute('data-metric');
            if (e.target.checked) {
                if (!STATE.activeMetrics.includes(metric)) STATE.activeMetrics.push(metric);
            } else {
                STATE.activeMetrics = STATE.activeMetrics.filter(m => m !== metric);
            }
            updateChart();
        });
    });

    // Reset
    const btnReset = document.getElementById('btn-env-reset');
    if (btnReset) {
        btnReset.addEventListener('click', () => {
            STATE.global = { minPrice: 50, maxPrice: 150, steps: 100, t: 1.0, r: 0.05, q: 0.0, v: 0.20 };
            STATE.legs = [{ id: generateId(), type: 'Call', position: 'Long', strike: 100, quantity: 1, barrierType: 'None', barrierLevel: 0 }];

            elMinPriceRange.value = 50; elMinPrice.value = 50;
            elMaxPriceRange.value = 150; elMaxPrice.value = 150;
            elTRange.value = 1.0; elTInput.value = 1.0;
            elRRange.value = 5.0; elRInput.value = 5.0;
            elQRange.value = 0.0; elQInput.value = 0.0;
            elVRange.value = 20.0; elVInput.value = 20.0;
            elNewBarrierType.value = 'None';
            elBarrierLevelCell.style.display = 'none';

            renderLegs();
            debouncedCompute(0);
        });
    }

    // Structured products
    const btnApplyStructure = document.getElementById('btn-apply-structure');
    const selectStructure = document.getElementById('structured-product-select');
    if (btnApplyStructure && selectStructure) {
        btnApplyStructure.addEventListener('click', () => {
            const structure = selectStructure.value;
            const k = parseFloat(elNewStrike.value) || 100;
            const mkLeg = (type, pos, strike) => ({ id: generateId(), type, position: pos, strike, quantity: 1, barrierType: 'None', barrierLevel: 0 });
            let newLegs = [];

            if (structure === 'straddle') {
                newLegs.push(mkLeg('Call', 'Long', k), mkLeg('Put', 'Long', k));
            } else if (structure === 'strangle') {
                newLegs.push(mkLeg('Put', 'Long', k - 10), mkLeg('Call', 'Long', k + 10));
            } else if (structure === 'bull_call') {
                newLegs.push(mkLeg('Call', 'Long', k), mkLeg('Call', 'Short', k + 10));
            } else if (structure === 'bear_put') {
                newLegs.push(mkLeg('Put', 'Long', k), mkLeg('Put', 'Short', k - 10));
            } else if (structure === 'iron_condor') {
                newLegs.push(mkLeg('Put', 'Long', k - 20), mkLeg('Put', 'Short', k - 10), mkLeg('Call', 'Short', k + 10), mkLeg('Call', 'Long', k + 20));
            }

            if (newLegs.length > 0) {
                STATE.legs = [...STATE.legs, ...newLegs];
                renderLegs();
                debouncedCompute(0);
            }
        });
    }

    // Animation
    const animSelect = document.getElementById('anim-param-select');
    const animPlayBtn = document.getElementById('anim-play-btn');
    let animRequest = null;

    const paramMap = {
        't': { numEl: elTInput, rangeEl: elTRange, key: 't', isPct: false },
        'v': { numEl: elVInput, rangeEl: elVRange, key: 'v', isPct: true },
        'r': { numEl: elRInput, rangeEl: elRRange, key: 'r', isPct: true },
        'q': { numEl: elQInput, rangeEl: elQRange, key: 'q', isPct: true }
    };

    function animateStep() {
        if (!STATE.isAnimating) return;
        const target = paramMap[animSelect.value];
        const currentVal = parseFloat(target.rangeEl.value);
        const maxVal = parseFloat(target.rangeEl.max);
        const step = parseFloat(target.rangeEl.step) || 0.1;

        if (currentVal >= maxVal) { stopAnimation(); return; }

        const nextVal = Math.min(currentVal + step, maxVal);
        target.rangeEl.value = nextVal.toFixed(2);
        target.numEl.value = nextVal.toFixed(2);
        STATE.global[target.key] = target.isPct ? nextVal / 100 : nextVal;
        computeGreeks();
        animRequest = requestAnimationFrame(animateStep);
    }

    function stopAnimation() {
        STATE.isAnimating = false;
        animPlayBtn.textContent = 'PLAY';
        animPlayBtn.style.color = 'var(--text-main)';
        if (animRequest) cancelAnimationFrame(animRequest);
    }

    animPlayBtn.addEventListener('click', () => {
        if (STATE.isAnimating) {
            stopAnimation();
        } else {
            STATE.isAnimating = true;
            animPlayBtn.textContent = 'PAUSE';
            animPlayBtn.style.color = 'var(--accent-secondary)';
            const target = paramMap[animSelect.value];
            if (parseFloat(target.rangeEl.value) >= parseFloat(target.rangeEl.max)) {
                target.rangeEl.value = target.rangeEl.min;
                target.numEl.value = target.rangeEl.min;
                STATE.global[target.key] = target.isPct ? parseFloat(target.rangeEl.min) / 100 : parseFloat(target.rangeEl.min);
            }
            animRequest = requestAnimationFrame(animateStep);
        }
    });

    // Add Leg
    btnAddLeg.addEventListener('click', () => {
        const strikeVal = parseFloat(elNewStrike.value);
        if (isNaN(strikeVal)) return;
        const bType = elNewBarrierType.value;
        const bLevel = bType !== 'None' ? parseFloat(elNewBarrier.value) || 120 : 0;

        STATE.legs.push({
            id: generateId(), type: elNewType.value, position: elNewPos.value,
            strike: strikeVal, quantity: 1, barrierType: bType, barrierLevel: bLevel
        });
        renderLegs();
        debouncedCompute(0);
    });

    // 3D Surface
    const btnGenSurface = document.getElementById('btn-generate-surface');
    if (btnGenSurface) {
        btnGenSurface.addEventListener('click', () => compute3DSurface());
    }
}

// --- Portfolio Rendering ---
function renderLegs() {
    elLegsContainer.innerHTML = '';
    elLegCount.textContent = STATE.legs.length;

    STATE.legs.forEach((leg) => {
        const row = document.createElement('div');
        row.className = `leg-row ${leg.type}`;
        const sign = leg.position === 'Long' ? '+' : '-';
        const barrierTag = leg.barrierType && leg.barrierType !== 'None'
            ? ` ${BARRIER_LABELS[leg.barrierType]}@${leg.barrierLevel.toFixed(0)}` : '';

        row.innerHTML = `
            <div class="leg-info">
                <div class="leg-text">${leg.position.toUpperCase()} ${leg.type.toUpperCase()} K=${leg.strike.toFixed(2)}${barrierTag}</div>
                <div class="leg-qty">QTY: ${sign}${leg.quantity}</div>
            </div>
            <button class="del-btn" data-id="${leg.id}">&times;</button>
        `;
        elLegsContainer.appendChild(row);
    });

    document.querySelectorAll('.del-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            STATE.legs = STATE.legs.filter(l => l.id !== id);
            renderLegs();
            debouncedCompute(0);
        });
    });
}

// ===========================================================================
// WASM-POWERED COMPUTATION (replaces HTTP fetch)
// ===========================================================================

function computeGreeks() {
    if (!STATE.wasmReady || STATE.legs.length === 0) {
        STATE.chartData = [];
        updateChart();
        return;
    }

    const { minPrice, maxPrice, steps } = STATE.global;
    const numSteps = Math.max(steps, 2);
    const stepSize = (maxPrice - minPrice) / (numSteps - 1);

    const packed = packLegsForWasm(STATE.legs, STATE.global);
    const legPtr = allocLegsInWasm(packed);

    const result = [];
    // WASM _calcGreeksAtSpot returns 14 doubles: indices 0-11 (price..ultima), 12=vanna, 13=volga
    const greekKeys = ['price', 'delta', 'gamma', 'theta', 'vega', 'rho', 'payoff', 'timeValue', 'speed', 'zomma', 'color', 'ultima', 'vanna', 'volga'];

    for (let i = 0; i < numSteps; i++) {
        const spot = minPrice + i * stepSize;
        const resPtr = Module._calcGreeksAtSpot(spot, STATE.legs.length, legPtr);

        const point = { spot };
        for (let g = 0; g < 14; g++) {
            point[greekKeys[g]] = Module.HEAPF64[resPtr / 8 + g];
        }
        result.push(point);
    }

    Module._free(legPtr);

    STATE.chartData = result;
    updateChart();
}

function compute3DSurface() {
    if (!STATE.wasmReady || STATE.legs.length === 0) return;

    const metric = document.getElementById('surface-metric').value;
    const secondVar = document.getElementById('surface-variable').value;

    const AXIS_RANGES = {
        timeToMaturity: { min: 0.05, max: STATE.global.t > 0.1 ? STATE.global.t : 2.0, label: 'Time to Maturity (T)' },
        volatility: { min: 0.05, max: 1.0, label: 'Volatility (σ)' },
        riskFreeRate: { min: 0.0, max: 0.20, label: 'Risk-Free Rate (r)' },
        dividendYield: { min: 0.0, max: 0.10, label: 'Dividend Yield (q)' }
    };

    const secRange = AXIS_RANGES[secondVar];
    const surfaceSteps = 40;

    const spotStep = (STATE.global.maxPrice - STATE.global.minPrice) / (surfaceSteps - 1);
    const secStep = (secRange.max - secRange.min) / (surfaceSteps - 1);

    const spots = [];
    const secondAxis = [];
    const surface = [];

    for (let i = 0; i < surfaceSteps; i++) spots.push(STATE.global.minPrice + i * spotStep);
    for (let j = 0; j < surfaceSteps; j++) secondAxis.push(secRange.min + j * secStep);

    const packed = packLegsForWasm(STATE.legs, STATE.global);
    const legPtr = allocLegsInWasm(packed);
    const secVarIdx = SEC_VAR_INDICES[secondVar];
    const metricIdx = METRIC_INDICES[metric];

    const surfPtr = Module._calcSurface3D(
        STATE.global.minPrice, STATE.global.maxPrice, surfaceSteps,
        secRange.min, secRange.max, surfaceSteps,
        secVarIdx, metricIdx,
        STATE.legs.length, legPtr
    );

    for (let j = 0; j < surfaceSteps; j++) {
        const row = [];
        for (let i = 0; i < surfaceSteps; i++) {
            row.push(Module.HEAPF64[surfPtr / 8 + j * surfaceSteps + i]);
        }
        surface.push(row);
    }
    Module._free(legPtr);

    render3DSurface({ spots, secondAxis, surface }, metric, secRange.label);
}



function render3DSurface(data, metric, secondAxisLabel) {
    const conf = METRIC_CONFIG[metric] || { color: '#00ffcc', label: metric.toUpperCase() };

    const trace = {
        x: data.spots,
        y: data.secondAxis,
        z: data.surface,
        type: 'surface',
        colorscale: [
            [0, 'rgb(5, 5, 7)'],
            [0.15, 'rgb(10, 30, 60)'],
            [0.35, 'rgb(0, 100, 180)'],
            [0.5, 'rgb(0, 200, 160)'],
            [0.65, 'rgb(0, 255, 204)'],
            [0.8, 'rgb(160, 255, 100)'],
            [1, 'rgb(255, 255, 255)']
        ],
        contours: {
            z: { show: true, usecolormap: true, highlightcolor: '#00ffcc', project: { z: false } }
        },
        lighting: { ambient: 0.6, diffuse: 0.5, specular: 0.3, roughness: 0.5 },
        opacity: 0.95,
        showscale: true,
        colorbar: {
            title: { text: conf.label, font: { color: '#6b6b80', size: 11, family: 'Inter, monospace' } },
            tickfont: { color: '#6b6b80', size: 10, family: 'Inter, monospace' },
            bordercolor: '#1d1d24',
            bgcolor: 'rgba(10,10,13,0.8)',
            len: 0.7
        }
    };

    const layout = {
        paper_bgcolor: '#050507',
        plot_bgcolor: '#050507',
        scene: {
            bgcolor: '#050507',
            xaxis: {
                title: { text: 'SPOT', font: { color: '#6b6b80', size: 11, family: 'Inter, monospace' } },
                tickfont: { color: '#6b6b80', size: 9, family: 'Inter, monospace' },
                gridcolor: '#1d1d24', zerolinecolor: '#333340',
                showbackground: true, backgroundcolor: '#0a0a0d'
            },
            yaxis: {
                title: { text: secondAxisLabel, font: { color: '#6b6b80', size: 11, family: 'Inter, monospace' } },
                tickfont: { color: '#6b6b80', size: 9, family: 'Inter, monospace' },
                gridcolor: '#1d1d24', zerolinecolor: '#333340',
                showbackground: true, backgroundcolor: '#0a0a0d'
            },
            zaxis: {
                title: { text: conf.label, font: { color: conf.color, size: 11, family: 'Inter, monospace' } },
                tickfont: { color: '#6b6b80', size: 9, family: 'Inter, monospace' },
                gridcolor: '#1d1d24', zerolinecolor: '#333340',
                showbackground: true, backgroundcolor: '#0a0a0d'
            },
            camera: { eye: { x: 1.6, y: -1.6, z: 0.8 } },
            aspectratio: { x: 1.2, y: 1.2, z: 0.8 }
        },
        margin: { l: 0, r: 0, t: 10, b: 10 },
        font: { family: 'Inter, monospace', color: '#6b6b80' }
    };

    Plotly.newPlot('surface3d', [trace], layout, {
        responsive: true, displayModeBar: true,
        modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'], displaylogo: false
    });
}

// --- Charting Engine ---
function initChart() {
    const ctx = document.getElementById('greeksChart').getContext('2d');
    Chart.defaults.color = 'var(--text-muted)';
    Chart.defaults.font.family = 'var(--font-mono)';
    Chart.defaults.scale.grid.color = 'var(--border-dim)';

    chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 10, 13, 0.95)',
                    titleColor: '#fff',
                    titleFont: { family: 'var(--font-mono)', size: 11 },
                    bodyColor: '#fff',
                    bodyFont: { family: 'var(--font-mono)', size: 11 },
                    borderColor: 'var(--border-bright)',
                    borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
                    callbacks: {
                        title: (ctx) => `SPOT: ${ctx[0].label}`,
                        label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(4)}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { drawBorder: false, color: 'var(--border-dim)' },
                    ticks: { color: '#ffffff', font: { size: 10 } }
                }
            }
        }
    });
}

function updateChart() {
    if (!chart) return;
    const dataPoints = STATE.chartData || [];
    chart.data.labels = dataPoints.map(d => d.spot.toFixed(2));
    chart.data.datasets = [];
    const newScales = { x: chart.options.scales.x };

    STATE.activeMetrics.forEach((metric, index) => {
        const conf = METRIC_CONFIG[metric] || { color: '#fff', label: metric.toUpperCase() };
        const axisId = `y-${metric}`;
        const metricData = dataPoints.map(d => d[metric]);

        chart.data.datasets.push({
            label: conf.label, data: metricData, borderColor: conf.color,
            backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0,
            pointHoverRadius: 4, tension: 0.05, yAxisID: axisId
        });

        const isPrimary = index === 0;
        let axisConf = {
            type: 'linear', display: true,
            position: isPrimary ? 'left' : 'right',
            grid: { drawOnChartArea: isPrimary, color: 'var(--border-dim)' },
            title: { display: true, text: conf.label, color: conf.color, font: { size: 9, weight: 700, family: 'var(--font-mono)' } },
            ticks: { color: conf.color, font: { size: 10, family: 'var(--font-mono)' } }
        };

        if (metricData.length > 0) {
            let dMin = Math.min(...metricData);
            let dMax = Math.max(...metricData);
            let dRange = dMax - dMin;
            if (dRange === 0) dRange = 1;
            let padding = dRange * 0.05;
            axisConf.min = dMin - padding;
            axisConf.max = dMax + padding;
        }

        newScales[axisId] = axisConf;
    });

    chart.options.scales = newScales;
    chart.update();
}

// Bootstrap — wait for WASM to be ready
function onWasmReady() {
    STATE.wasmReady = true;
    bindUIElements();
    renderLegs();
    initChart();
    computeGreeks();
}

// Emscripten Module callback
if (typeof Module !== 'undefined') {
    if (Module.calledRun) {
        // Already initialized
        document.addEventListener('DOMContentLoaded', onWasmReady);
    } else {
        Module.onRuntimeInitialized = () => {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', onWasmReady);
            } else {
                onWasmReady();
            }
        };
    }
} else {
    // Fallback: poll for Module
    document.addEventListener('DOMContentLoaded', () => {
        const check = setInterval(() => {
            if (typeof Module !== 'undefined' && Module.calledRun) {
                clearInterval(check);
                onWasmReady();
            }
        }, 50);
    });
}
