// --- WASM Helpers ---
const BARRIER_TYPE_MAP = {
    None: 0,
    UpIn: 1,
    UpOut: 2,
    DownIn: 3,
    DownOut: 4
};

const METRIC_INDICES = {
    price: 0,
    delta: 1,
    gamma: 2,
    theta: 3,
    vega: 4,
    rho: 5,
    payoff: 6,
    speed: 7,
    zomma: 8,
    color: 9,
    ultima: 10,
    vanna: 11,
    volga: 12
};

const SEC_VAR_INDICES = {
    timeToMaturity: 0,
    volatility: 1,
    riskFreeRate: 2,
    dividendYield: 3
};

// --- Amundi-inspired palette ---
const THEME = {
    navy: '#00205B',
    blue: '#00A3E0',
    blueDark: '#0077A8',
    blueLight: '#E5F6FC',
    white: '#FFFFFF',
    panel: '#F5F8FC',
    grid: '#D9E2EC',
    border: '#9DB2CA',
    text: '#00205B',
    muted: '#60738D',
    alert: '#C54E5C'
};

// Pack legs into a flat Float64Array for WASM
function packLegsForWasm(legs, global) {
    const arr = new Float64Array(legs.length * 10);

    legs.forEach((leg, i) => {
        const off = i * 10;

        arr[off] = leg.type === 'Call' ? 0 : 1;
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

// Allocate packed leg data in WASM heap
function allocLegsInWasm(packedLegs) {
    const nBytes = packedLegs.length * 8;
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

const toggleCheckboxes = document.querySelectorAll(
    '.metric-toggle input[type="checkbox"]'
);

let chart = null;

// --- Chart colors ---
const METRIC_CONFIG = {
    payoff: {
        color: '#00205B',
        label: 'PAYOFF'
    },
    price: {
        color: '#00A3E0',
        label: 'PRICE'
    },
    delta: {
        color: '#0077A8',
        label: 'DELTA'
    },
    gamma: {
        color: '#536FA8',
        label: 'GAMMA'
    },
    vega: {
        color: '#3C91BD',
        label: 'VEGA'
    },
    theta: {
        color: '#C54E5C',
        label: 'THETA'
    },
    rho: {
        color: '#69C4E5',
        label: 'RHO'
    },
    speed: {
        color: '#006C98',
        label: 'SPEED'
    },
    zomma: {
        color: '#2494C3',
        label: 'ZOMMA'
    },
    color: {
        color: '#536FA8',
        label: 'COLOR'
    },
    ultima: {
        color: '#75C9E5',
        label: 'ULTIMA'
    },
    vanna: {
        color: '#008BC3',
        label: 'VANNA'
    },
    volga: {
        color: '#3F5F99',
        label: 'VOLGA'
    }
};

const BARRIER_LABELS = {
    None: '',
    UpIn: '↑IN',
    UpOut: '↑OUT',
    DownIn: '↓IN',
    DownOut: '↓OUT'
};

// --- Utilities ---
function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

let timeoutId;

function debouncedCompute(delay = 50) {
    if (timeoutId) {
        clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => computeGreeks(), delay);
}

// --- Initialization & Binding ---
function bindUIElements() {
    const bindSyncedInput = (
        numEl,
        rangeEl,
        stateKey,
        isPercent = false
    ) => {
        const updateState = (value) => {
            if (Number.isNaN(value)) {
                return;
            }

            STATE.global[stateKey] = isPercent
                ? value / 100
                : value;

            debouncedCompute();
        };

        numEl.addEventListener('input', (event) => {
            const value = parseFloat(event.target.value);

            if (!Number.isNaN(value)) {
                rangeEl.value = value;
            }

            updateState(value);
        });

        rangeEl.addEventListener('input', (event) => {
            const value = parseFloat(event.target.value);

            if (!Number.isNaN(value)) {
                numEl.value = value;
            }

            updateState(value);
        });
    };

    bindSyncedInput(
        elMinPrice,
        elMinPriceRange,
        'minPrice'
    );

    bindSyncedInput(
        elMaxPrice,
        elMaxPriceRange,
        'maxPrice'
    );

    bindSyncedInput(
        elTInput,
        elTRange,
        't'
    );

    bindSyncedInput(
        elRInput,
        elRRange,
        'r',
        true
    );

    bindSyncedInput(
        elQInput,
        elQRange,
        'q',
        true
    );

    bindSyncedInput(
        elVInput,
        elVRange,
        'v',
        true
    );

    elNewStrike.addEventListener('input', (event) => {
        const value = parseFloat(event.target.value);

        if (!Number.isNaN(value)) {
            elNewStrikeRange.value = value;
        }
    });

    elNewStrikeRange.addEventListener('input', (event) => {
        const value = parseFloat(event.target.value);

        if (!Number.isNaN(value)) {
            elNewStrike.value = value;
        }
    });

    elNewBarrier.addEventListener('input', (event) => {
        const value = parseFloat(event.target.value);

        if (!Number.isNaN(value)) {
            elNewBarrierRange.value = value;
        }
    });

    elNewBarrierRange.addEventListener('input', (event) => {
        const value = parseFloat(event.target.value);

        if (!Number.isNaN(value)) {
            elNewBarrier.value = value;
        }
    });

    elNewBarrierType.addEventListener('change', (event) => {
        elBarrierLevelCell.style.display =
            event.target.value === 'None'
                ? 'none'
                : 'flex';
    });

    STATE.global.minPrice =
        parseFloat(elMinPrice.value) || 50;

    STATE.global.maxPrice =
        parseFloat(elMaxPrice.value) || 150;

    STATE.global.t =
        parseFloat(elTInput.value) || 1.0;

    STATE.global.r =
        (parseFloat(elRInput.value) || 5.0) / 100;

    STATE.global.q =
        (parseFloat(elQInput.value) || 0.0) / 100;

    STATE.global.v =
        (parseFloat(elVInput.value) || 20.0) / 100;

    toggleCheckboxes.forEach((checkbox) => {
        checkbox.addEventListener('change', (event) => {
            const metric =
                event.target.getAttribute('data-metric');

            if (event.target.checked) {
                if (!STATE.activeMetrics.includes(metric)) {
                    STATE.activeMetrics.push(metric);
                }
            } else {
                STATE.activeMetrics =
                    STATE.activeMetrics.filter(
                        (item) => item !== metric
                    );
            }

            updateChart();
        });
    });

    // Reset
    const btnReset =
        document.getElementById('btn-env-reset');

    if (btnReset) {
        btnReset.addEventListener('click', () => {
            STATE.global = {
                minPrice: 50,
                maxPrice: 150,
                steps: 100,
                t: 1.0,
                r: 0.05,
                q: 0.0,
                v: 0.20
            };

            STATE.legs = [
                {
                    id: generateId(),
                    type: 'Call',
                    position: 'Long',
                    strike: 100,
                    quantity: 1,
                    barrierType: 'None',
                    barrierLevel: 0
                }
            ];

            elMinPriceRange.value = 50;
            elMinPrice.value = 50;

            elMaxPriceRange.value = 150;
            elMaxPrice.value = 150;

            elTRange.value = 1.0;
            elTInput.value = 1.0;

            elRRange.value = 5.0;
            elRInput.value = 5.0;

            elQRange.value = 0.0;
            elQInput.value = 0.0;

            elVRange.value = 20.0;
            elVInput.value = 20.0;

            elNewBarrierType.value = 'None';
            elBarrierLevelCell.style.display = 'none';

            renderLegs();
            debouncedCompute(0);
        });
    }

    // Structured products
    const btnApplyStructure =
        document.getElementById('btn-apply-structure');

    const selectStructure =
        document.getElementById('structured-product-select');

    if (btnApplyStructure && selectStructure) {
        btnApplyStructure.addEventListener('click', () => {
            const structure = selectStructure.value;
            const strike =
                parseFloat(elNewStrike.value) || 100;

            const createLeg = (
                type,
                position,
                legStrike
            ) => ({
                id: generateId(),
                type,
                position,
                strike: legStrike,
                quantity: 1,
                barrierType: 'None',
                barrierLevel: 0
            });

            const newLegs = [];

            if (structure === 'straddle') {
                newLegs.push(
                    createLeg('Call', 'Long', strike),
                    createLeg('Put', 'Long', strike)
                );
            } else if (structure === 'strangle') {
                newLegs.push(
                    createLeg('Put', 'Long', strike - 10),
                    createLeg('Call', 'Long', strike + 10)
                );
            } else if (structure === 'bull_call') {
                newLegs.push(
                    createLeg('Call', 'Long', strike),
                    createLeg('Call', 'Short', strike + 10)
                );
            } else if (structure === 'bear_put') {
                newLegs.push(
                    createLeg('Put', 'Long', strike),
                    createLeg('Put', 'Short', strike - 10)
                );
            } else if (structure === 'iron_condor') {
                newLegs.push(
                    createLeg('Put', 'Long', strike - 20),
                    createLeg('Put', 'Short', strike - 10),
                    createLeg('Call', 'Short', strike + 10),
                    createLeg('Call', 'Long', strike + 20)
                );
            }

            if (newLegs.length > 0) {
                STATE.legs = [
                    ...STATE.legs,
                    ...newLegs
                ];

                renderLegs();
                debouncedCompute(0);
            }
        });
    }

    // Animation
    const animSelect =
        document.getElementById('anim-param-select');

    const animPlayBtn =
        document.getElementById('anim-play-btn');

    let animRequest = null;

    const paramMap = {
        t: {
            numEl: elTInput,
            rangeEl: elTRange,
            key: 't',
            isPct: false
        },
        v: {
            numEl: elVInput,
            rangeEl: elVRange,
            key: 'v',
            isPct: true
        },
        r: {
            numEl: elRInput,
            rangeEl: elRRange,
            key: 'r',
            isPct: true
        },
        q: {
            numEl: elQInput,
            rangeEl: elQRange,
            key: 'q',
            isPct: true
        }
    };

    function animateStep() {
        if (!STATE.isAnimating) {
            return;
        }

        const target =
            paramMap[animSelect.value];

        const currentValue =
            parseFloat(target.rangeEl.value);

        const maxValue =
            parseFloat(target.rangeEl.max);

        const step =
            parseFloat(target.rangeEl.step) || 0.1;

        if (currentValue >= maxValue) {
            stopAnimation();
            return;
        }

        const nextValue =
            Math.min(currentValue + step, maxValue);

        target.rangeEl.value =
            nextValue.toFixed(2);

        target.numEl.value =
            nextValue.toFixed(2);

        STATE.global[target.key] =
            target.isPct
                ? nextValue / 100
                : nextValue;

        computeGreeks();

        animRequest =
            requestAnimationFrame(animateStep);
    }

    function stopAnimation() {
        STATE.isAnimating = false;

        animPlayBtn.textContent = 'PLAY';
        animPlayBtn.style.color = THEME.text;

        if (animRequest) {
            cancelAnimationFrame(animRequest);
        }
    }

    animPlayBtn.addEventListener('click', () => {
        if (STATE.isAnimating) {
            stopAnimation();
            return;
        }

        STATE.isAnimating = true;

        animPlayBtn.textContent = 'PAUSE';
        animPlayBtn.style.color = THEME.blue;

        const target =
            paramMap[animSelect.value];

        if (
            parseFloat(target.rangeEl.value) >=
            parseFloat(target.rangeEl.max)
        ) {
            target.rangeEl.value =
                target.rangeEl.min;

            target.numEl.value =
                target.rangeEl.min;

            STATE.global[target.key] =
                target.isPct
                    ? parseFloat(target.rangeEl.min) / 100
                    : parseFloat(target.rangeEl.min);
        }

        animRequest =
            requestAnimationFrame(animateStep);
    });

    // Add Leg
    btnAddLeg.addEventListener('click', () => {
        const strikeValue =
            parseFloat(elNewStrike.value);

        if (Number.isNaN(strikeValue)) {
            return;
        }

        const barrierType =
            elNewBarrierType.value;

        const barrierLevel =
            barrierType !== 'None'
                ? parseFloat(elNewBarrier.value) || 120
                : 0;

        STATE.legs.push({
            id: generateId(),
            type: elNewType.value,
            position: elNewPos.value,
            strike: strikeValue,
            quantity: 1,
            barrierType,
            barrierLevel
        });

        renderLegs();
        debouncedCompute(0);
    });

    // 3D Surface
    const btnGenSurface =
        document.getElementById(
            'btn-generate-surface'
        );

    if (btnGenSurface) {
        btnGenSurface.addEventListener(
            'click',
            () => compute3DSurface()
        );
    }
}

// --- Portfolio Rendering ---
function renderLegs() {
    elLegsContainer.innerHTML = '';
    elLegCount.textContent = STATE.legs.length;

    STATE.legs.forEach((leg) => {
        const row =
            document.createElement('div');

        row.className =
            `leg-row ${leg.type}`;

        const sign =
            leg.position === 'Long' ? '+' : '-';

        const barrierTag =
            leg.barrierType &&
            leg.barrierType !== 'None'
                ? ` ${BARRIER_LABELS[leg.barrierType]}@${leg.barrierLevel.toFixed(0)}`
                : '';

        row.innerHTML = `
            <div class="leg-info">
                <div class="leg-text">
                    ${leg.position.toUpperCase()}
                    ${leg.type.toUpperCase()}
                    K=${leg.strike.toFixed(2)}${barrierTag}
                </div>

                <div class="leg-qty">
                    QTY: ${sign}${leg.quantity}
                </div>
            </div>

            <button
                class="del-btn"
                data-id="${leg.id}"
            >
                &times;
            </button>
        `;

        elLegsContainer.appendChild(row);
    });

    document
        .querySelectorAll('.del-btn')
        .forEach((button) => {
            button.addEventListener(
                'click',
                (event) => {
                    const id =
                        event.target.getAttribute(
                            'data-id'
                        );

                    STATE.legs =
                        STATE.legs.filter(
                            (leg) => leg.id !== id
                        );

                    renderLegs();
                    debouncedCompute(0);
                }
            );
        });
}

// ===========================================================================
// WASM-POWERED COMPUTATION
// ===========================================================================

function computeGreeks() {
    if (
        !STATE.wasmReady ||
        STATE.legs.length === 0
    ) {
        STATE.chartData = [];
        updateChart();
        return;
    }

    const {
        minPrice,
        maxPrice,
        steps
    } = STATE.global;

    const numSteps =
        Math.max(steps, 2);

    const stepSize =
        (maxPrice - minPrice) /
        (numSteps - 1);

    const packed =
        packLegsForWasm(
            STATE.legs,
            STATE.global
        );

    const legPtr =
        allocLegsInWasm(packed);

    const result = [];

    const greekKeys = [
        'price',
        'delta',
        'gamma',
        'theta',
        'vega',
        'rho',
        'payoff',
        'timeValue',
        'speed',
        'zomma',
        'color',
        'ultima',
        'vanna',
        'volga'
    ];

    for (let i = 0; i < numSteps; i++) {
        const spot =
            minPrice + i * stepSize;

        const resultPtr =
            Module._calcGreeksAtSpot(
                spot,
                STATE.legs.length,
                legPtr
            );

        const point = { spot };

        for (let g = 0; g < 14; g++) {
            point[greekKeys[g]] =
                Module.HEAPF64[
                    resultPtr / 8 + g
                ];
        }

        result.push(point);
    }

    Module._free(legPtr);

    STATE.chartData = result;
    updateChart();
}

function compute3DSurface() {
    if (
        !STATE.wasmReady ||
        STATE.legs.length === 0
    ) {
        return;
    }

    const metric =
        document.getElementById(
            'surface-metric'
        ).value;

    const secondVar =
        document.getElementById(
            'surface-variable'
        ).value;

    const AXIS_RANGES = {
        timeToMaturity: {
            min: 0.05,
            max:
                STATE.global.t > 0.1
                    ? STATE.global.t
                    : 2.0,
            label: 'Time to Maturity (T)'
        },

        volatility: {
            min: 0.05,
            max: 1.0,
            label: 'Volatility (σ)'
        },

        riskFreeRate: {
            min: 0.0,
            max: 0.20,
            label: 'Risk-Free Rate (r)'
        },

        dividendYield: {
            min: 0.0,
            max: 0.10,
            label: 'Dividend Yield (q)'
        }
    };

    const secRange =
        AXIS_RANGES[secondVar];

    const surfaceSteps = 40;

    const spotStep =
        (
            STATE.global.maxPrice -
            STATE.global.minPrice
        ) /
        (surfaceSteps - 1);

    const secStep =
        (
            secRange.max -
            secRange.min
        ) /
        (surfaceSteps - 1);

    const spots = [];
    const secondAxis = [];
    const surface = [];

    for (
        let i = 0;
        i < surfaceSteps;
        i++
    ) {
        spots.push(
            STATE.global.minPrice +
            i * spotStep
        );
    }

    for (
        let j = 0;
        j < surfaceSteps;
        j++
    ) {
        secondAxis.push(
            secRange.min +
            j * secStep
        );
    }

    const packed =
        packLegsForWasm(
            STATE.legs,
            STATE.global
        );

    const legPtr =
        allocLegsInWasm(packed);

    const secVarIdx =
        SEC_VAR_INDICES[secondVar];

    const metricIdx =
        METRIC_INDICES[metric];

    const surfacePtr =
        Module._calcSurface3D(
            STATE.global.minPrice,
            STATE.global.maxPrice,
            surfaceSteps,
            secRange.min,
            secRange.max,
            surfaceSteps,
            secVarIdx,
            metricIdx,
            STATE.legs.length,
            legPtr
        );

    for (
        let j = 0;
        j < surfaceSteps;
        j++
    ) {
        const row = [];

        for (
            let i = 0;
            i < surfaceSteps;
            i++
        ) {
            row.push(
                Module.HEAPF64[
                    surfacePtr / 8 +
                    j * surfaceSteps +
                    i
                ]
            );
        }

        surface.push(row);
    }

    Module._free(legPtr);

    render3DSurface(
        {
            spots,
            secondAxis,
            surface
        },
        metric,
        secRange.label
    );
}

// --- Plotly 3D Surface ---
function render3DSurface(
    data,
    metric,
    secondAxisLabel
) {
    const conf =
        METRIC_CONFIG[metric] || {
            color: THEME.blue,
            label: metric.toUpperCase()
        };

    const plotFont =
        'Inter, Arial, sans-serif';

    const trace = {
        x: data.spots,
        y: data.secondAxis,
        z: data.surface,
        type: 'surface',

        colorscale: [
            [0.00, '#00205B'],
            [0.18, '#004B87'],
            [0.36, '#0077A8'],
            [0.56, '#00A3E0'],
            [0.76, '#75C9E5'],
            [1.00, '#E5F6FC']
        ],

        contours: {
            z: {
                show: true,
                usecolormap: true,
                highlightcolor: THEME.blue,
                project: {
                    z: false
                }
            }
        },

        lighting: {
            ambient: 0.72,
            diffuse: 0.55,
            specular: 0.2,
            roughness: 0.65
        },

        opacity: 0.97,
        showscale: true,

        colorbar: {
            title: {
                text: conf.label,
                font: {
                    color: THEME.navy,
                    size: 11,
                    family: plotFont
                }
            },

            tickfont: {
                color: THEME.muted,
                size: 10,
                family: plotFont
            },

            bordercolor: THEME.grid,
            borderwidth: 1,
            bgcolor: 'rgba(255,255,255,0.96)',
            len: 0.7
        }
    };

    const axisStyle = {
        tickfont: {
            color: THEME.muted,
            size: 9,
            family: plotFont
        },

        gridcolor: THEME.grid,
        zerolinecolor: THEME.border,
        linecolor: THEME.border,

        showbackground: true,
        backgroundcolor: THEME.panel
    };

    const layout = {
        paper_bgcolor: THEME.white,
        plot_bgcolor: THEME.white,

        scene: {
            bgcolor: THEME.white,

            xaxis: {
                ...axisStyle,

                title: {
                    text: 'SPOT',
                    font: {
                        color: THEME.navy,
                        size: 11,
                        family: plotFont
                    }
                }
            },

            yaxis: {
                ...axisStyle,

                title: {
                    text: secondAxisLabel,
                    font: {
                        color: THEME.navy,
                        size: 11,
                        family: plotFont
                    }
                }
            },

            zaxis: {
                ...axisStyle,

                title: {
                    text: conf.label,
                    font: {
                        color: conf.color,
                        size: 11,
                        family: plotFont
                    }
                }
            },

            camera: {
                eye: {
                    x: 1.6,
                    y: -1.6,
                    z: 0.8
                }
            },

            aspectratio: {
                x: 1.2,
                y: 1.2,
                z: 0.8
            }
        },

        margin: {
            l: 0,
            r: 0,
            t: 10,
            b: 10
        },

        font: {
            family: plotFont,
            color: THEME.muted
        }
    };

    const config = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: [
            'toImage',
            'sendDataToCloud'
        ],
        displaylogo: false
    };

    Plotly.newPlot(
        'surface3d',
        [trace],
        layout,
        config
    );
}

// --- Chart.js Engine ---
function initChart() {
    const canvas =
        document.getElementById(
            'greeksChart'
        );

    if (!canvas) {
        console.error(
            'Canvas #greeksChart introuvable.'
        );
        return;
    }

    const ctx =
        canvas.getContext('2d');

    Chart.defaults.color =
        THEME.muted;

    Chart.defaults.font.family =
        "'Inter', Arial, sans-serif";

    Chart.defaults.scale.grid.color =
        THEME.grid;

    chart = new Chart(ctx, {
        type: 'line',

        data: {
            labels: [],
            datasets: []
        },

        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,

            interaction: {
                mode: 'index',
                intersect: false
            },

            plugins: {
                legend: {
                    display: false
                },

                tooltip: {
                    backgroundColor:
                        'rgba(0, 32, 91, 0.96)',

                    titleColor:
                        THEME.white,

                    titleFont: {
                        family:
                            "'Inter', Arial, sans-serif",
                        size: 11,
                        weight: '600'
                    },

                    bodyColor:
                        THEME.white,

                    bodyFont: {
                        family:
                            "'Inter', Arial, sans-serif",
                        size: 11
                    },

                    borderColor:
                        THEME.blue,

                    borderWidth: 1,
                    cornerRadius: 2,
                    padding: 10,
                    boxPadding: 4,
                    usePointStyle: true,

                    callbacks: {
                        title: (contexts) =>
                            `SPOT: ${contexts[0].label}`,

                        label: (context) =>
                            ` ${context.dataset.label}: ${context.parsed.y.toFixed(4)}`
                    }
                }
            },

            scales: {
                x: {
                    grid: {
                        drawBorder: false,
                        color: THEME.grid
                    },

                    border: {
                        color: THEME.border
                    },

                    ticks: {
                        color: THEME.muted,

                        font: {
                            family:
                                "'Inter', Arial, sans-serif",
                            size: 10
                        }
                    }
                }
            }
        }
    });
}

function updateChart() {
    if (!chart) {
        return;
    }

    const dataPoints =
        STATE.chartData || [];

    chart.data.labels =
        dataPoints.map(
            (point) =>
                point.spot.toFixed(2)
        );

    chart.data.datasets = [];

    const newScales = {
        x: chart.options.scales.x
    };

    STATE.activeMetrics.forEach(
        (metric, index) => {
            const conf =
                METRIC_CONFIG[metric] || {
                    color: THEME.navy,
                    label: metric.toUpperCase()
                };

            const axisId =
                `y-${metric}`;

            const metricData =
                dataPoints.map(
                    (point) => point[metric]
                );

            chart.data.datasets.push({
                label: conf.label,
                data: metricData,

                borderColor: conf.color,
                backgroundColor: 'transparent',

                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointHoverBackgroundColor:
                    conf.color,

                pointHoverBorderColor:
                    THEME.white,

                pointHoverBorderWidth: 1,

                tension: 0.05,
                yAxisID: axisId
            });

            const isPrimary =
                index === 0;

            const axisConf = {
                type: 'linear',
                display: true,

                position:
                    isPrimary
                        ? 'left'
                        : 'right',

                grid: {
                    drawOnChartArea:
                        isPrimary,

                    color:
                        THEME.grid
                },

                border: {
                    color:
                        isPrimary
                            ? THEME.border
                            : conf.color
                },

                title: {
                    display: true,
                    text: conf.label,
                    color: conf.color,

                    font: {
                        size: 9,
                        weight: 700,
                        family:
                            "'Inter', Arial, sans-serif"
                    }
                },

                ticks: {
                    color: conf.color,

                    font: {
                        size: 10,
                        family:
                            "'Inter', Arial, sans-serif"
                    }
                }
            };

            if (metricData.length > 0) {
                const finiteValues =
                    metricData.filter(
                        Number.isFinite
                    );

                if (finiteValues.length > 0) {
                    let dataMin =
                        Math.min(
                            ...finiteValues
                        );

                    let dataMax =
                        Math.max(
                            ...finiteValues
                        );

                    let dataRange =
                        dataMax - dataMin;

                    if (dataRange === 0) {
                        dataRange =
                            Math.abs(dataMax) *
                            0.1 || 1;
                    }

                    const padding =
                        dataRange * 0.05;

                    axisConf.min =
                        dataMin - padding;

                    axisConf.max =
                        dataMax + padding;
                }
            }

            newScales[axisId] =
                axisConf;
        }
    );

    chart.options.scales =
        newScales;

    chart.update();
}

// Bootstrap — wait for WASM
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
        if (
            document.readyState ===
            'loading'
        ) {
            document.addEventListener(
                'DOMContentLoaded',
                onWasmReady
            );
        } else {
            onWasmReady();
        }
    } else {
        Module.onRuntimeInitialized =
            () => {
                if (
                    document.readyState ===
                    'loading'
                ) {
                    document.addEventListener(
                        'DOMContentLoaded',
                        onWasmReady
                    );
                } else {
                    onWasmReady();
                }
            };
    }
} else {
    // Fallback: poll for Module
    document.addEventListener(
        'DOMContentLoaded',
        () => {
            const check =
                setInterval(() => {
                    if (
                        typeof Module !==
                            'undefined' &&
                        Module.calledRun
                    ) {
                        clearInterval(check);
                        onWasmReady();
                    }
                }, 50);
        }
    );
}
