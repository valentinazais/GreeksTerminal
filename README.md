# Option Greeks Terminal — WASM-Powered Pricing Engine

Live app: [https://valentinazais.github.io/GreeksTerminal/](https://valentinazais.github.io/GreeksTerminal/)

## Overview
Real-time option Greeks simulator running entirely in-browser via WebAssembly. C++ Black-Scholes engine compiled to WASM (Emscripten). Computes prices, payoffs, time value, 1st-order Greeks (Delta, Gamma, Theta, Vega, Rho), and 3rd-order Greeks (Speed, Zomma, Color, Ultima). Supports vanilla + barrier options (knock-in/knock-out). Interactive 2D overlay charts + 3D Greek surfaces.

## Features
- **Shared Parameters**: Spot range (min/max), T (expiry), r (risk-free rate), q (dividend yield), σ (volatility). Dual input (number/slider) with sync.
- **Strategy Builder**: Add/remove legs (call/put, strike K, long/short, quantity).
- **Structured Products**: One-click presets — Straddle, Strangle, Bull Call, Bear Put, Iron Condor.
- **Barrier Options**: Up-In, Up-Out, Down-In, Down-Out. Analytical Merton (1973) closed-form pricing. Greeks via finite-difference bumps.
- **Metrics**: Payoff, price, time value, Delta, Gamma, Theta, Vega, Rho, Speed, Zomma, Color, Ultima. Each with fractional derivative notation (∂V/∂S, ∂²V/∂S², etc.).
- **2D Overlay Chart**: Multi-metric overlay vs. underlying S, each with independent y-axis. Fixed colors per metric.
- **3D Greek Surface**: Any Greek plotted over Spot × secondary variable (T, σ, r, q). Interactive Plotly.js surface with rotation/zoom.
- **Parameter Sweep**: Animate any parameter (T, σ, r, q) over its range — watch Greeks evolve in real-time.
- **Reset**: Reinitialize environment to defaults.

## Architecture
```
C++ (BlackScholes.cpp) → Emscripten → WASM (greeks.wasm)
                                         ↓
          Browser: app.js → WASM ccall → instant computation → Chart.js / Plotly.js
```
- **C++**: BlackScholes pricing engine + barrier formulas. Compiled to WebAssembly.
- **JavaScript**: UI logic, state management, chart rendering. Calls WASM functions directly (no HTTP).
- **HTML/CSS**: Terminal-themed interface with dark mode aesthetic.

Zero backend. Zero latency. Runs offline.

## Usage
1. **Left Panel > Portfolio Legs**: View/remove legs.
2. **Left Panel > Structured Product**: Select preset + Apply.
3. **Left Panel > New Position**: Type, position, strike, barrier type/level → Append Leg.
4. **Right Panel > Environment**: Adjust spot range, T, r, q, σ.
5. **Right Panel > Active Metrics**: Toggle Greeks to overlay on chart.
6. **Right Panel > Parameter Sweep**: Select variable + Play to animate.
7. **Center > 3D Greek Surface**: Select Greek + 2nd axis → Generate.

## Model Details
- Black-Scholes-Merton (continuous dividend q).
- Barrier options: Merton (1973) analytical closed-form (A/B/C/D terms).
- Knock-in via in-out parity: KnockIn = Vanilla − KnockOut.
- Barrier Greeks: Central finite-difference (δS = 0.1%, δT = 0.001y, δσ = 0.1%, δr = 1bp).
- 3rd-order Greeks: Speed (∂³V/∂S³), Zomma (∂³V/∂S²∂σ), Color (∂³V/∂S²∂t), Ultima (∂³V/∂σ³).
- S range: [min, max] with 100 sample points.

## Build from Source
```bash
# Install Emscripten
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source emsdk_env.sh

# Compile to WASM
cd wasm && bash build_wasm.sh
# Outputs: frontend/js/greeks.js + frontend/js/greeks.wasm

# Serve locally (WASM requires HTTP)
cd frontend && python3 -m http.server 8000
# Open http://localhost:8000
```

## Limitations
- European options only.
- Constant parameters (no smile/skew).
- No transaction costs.
- Barrier monitoring: continuous (not discrete).
