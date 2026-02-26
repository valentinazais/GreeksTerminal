#include "BlackScholes.h"
#include <algorithm>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

double BlackScholes::normalPDF(double x) {
  return std::exp(-0.5 * x * x) / std::sqrt(2.0 * M_PI);
}

double BlackScholes::normalCDF(double x) {
  return 0.5 * std::erfc(-x * M_SQRT1_2);
}

// --- Vanilla Black-Scholes (no barrier) ---
Greeks BlackScholes::calculateVanilla(double S, const OptionParams &params) {
  double K = params.strike;
  double T = params.timeToMaturity;
  double v = params.volatility;
  double r = params.riskFreeRate;
  double q = params.dividendYield;

  Greeks greeks = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                   0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0};

  // Handle expiration or zero vol
  if (T <= 0.0 || v <= 0.0) {
    if (params.type == "Call" || params.type == "call") {
      greeks.price = std::max(S - K, 0.0);
      greeks.delta = S > K ? 1.0 : 0.0;
      greeks.payoff = std::max(S - K, 0.0);
    } else {
      greeks.price = std::max(K - S, 0.0);
      greeks.delta = S < K ? -1.0 : 0.0;
      greeks.payoff = std::max(K - S, 0.0);
    }
    greeks.timeValue = 0.0;
    return greeks;
  }

  double d1 =
      (std::log(S / K) + (r - q + 0.5 * v * v) * T) / (v * std::sqrt(T));
  double d2 = d1 - v * std::sqrt(T);

  double Nd1 = normalCDF(d1);
  double Nd2 = normalCDF(d2);
  double nMinusd1 = normalCDF(-d1);
  double nMinusd2 = normalCDF(-d2);
  double nd1 = normalPDF(d1);

  double ert = std::exp(-r * T);
  double eqt = std::exp(-q * T);

  // Common Greeks and 3rd Order Derivations
  double gamma_common = eqt * nd1 / (S * v * std::sqrt(T));
  double vega_common = S * eqt * std::sqrt(T) * nd1;
  double speed_common = -gamma_common / S * (d1 / (v * std::sqrt(T)) + 1.0);
  double zomma_common = gamma_common * (d1 * d2 - 1.0) / v;
  double color_common =
      -eqt * nd1 / (2.0 * S * T * v * std::sqrt(T)) *
      (2.0 * q * T + 1.0 +
       (2.0 * (r - q) * T - d2 * v * std::sqrt(T)) * d1 / (v * std::sqrt(T)));
  double vanna_common = -eqt * nd1 * d2 / v;
  double volga_common = vega_common * d1 * d2 / v;
  double ultima_common =
      -vega_common * (d1 * d2 * (1.0 - d1 * d2) + d1 * d1 + d2 * d2) / (v * v);

  if (params.type == "Call" || params.type == "call") {
    greeks.price = S * eqt * Nd1 - K * ert * Nd2;
    greeks.delta = eqt * Nd1;
    greeks.gamma = gamma_common;
    greeks.theta = -(S * eqt * nd1 * v) / (2.0 * std::sqrt(T)) -
                   r * K * ert * Nd2 + q * S * eqt * Nd1;
    greeks.vega = vega_common;
    greeks.rho = K * T * ert * Nd2;
    greeks.payoff = std::max(S - K, 0.0);
  } else { // Put
    greeks.price = K * ert * nMinusd2 - S * eqt * nMinusd1;
    greeks.delta = -eqt * nMinusd1;
    greeks.gamma = gamma_common;
    greeks.theta = -(S * eqt * nd1 * v) / (2.0 * std::sqrt(T)) +
                   r * K * ert * nMinusd2 - q * S * eqt * nMinusd1;
    greeks.vega = vega_common;
    greeks.rho = -K * T * ert * nMinusd2;
    greeks.payoff = std::max(K - S, 0.0);
  }

  greeks.timeValue = greeks.price - greeks.payoff;
  greeks.speed = speed_common;
  greeks.zomma = zomma_common;
  greeks.color = color_common;
  greeks.ultima = ultima_common;
  greeks.vanna = vanna_common;
  greeks.volga = volga_common;

  return greeks;
}

// --- Analytical Barrier Option Price (Merton 1973) ---
// Returns the theoretical price of a single barrier option (before position
// multiplier).
double BlackScholes::barrierPrice(double S, const OptionParams &params) {
  double K = params.strike;
  double T = params.timeToMaturity;
  double v = params.volatility;
  double r = params.riskFreeRate;
  double q = params.dividendYield;
  double H = params.barrierLevel;

  if (T <= 0.0 || v <= 0.0 || H <= 0.0) {
    // At expiration, barrier trivially resolves
    bool isCall = (params.type == "Call" || params.type == "call");
    double intrinsic = isCall ? std::max(S - K, 0.0) : std::max(K - S, 0.0);

    bool knockedOut = false;
    if (params.barrierType == "UpOut" && S >= H)
      knockedOut = true;
    if (params.barrierType == "DownOut" && S <= H)
      knockedOut = true;

    bool knockedIn = true; // default for In types
    if (params.barrierType == "UpIn" && S < H)
      knockedIn = false;
    if (params.barrierType == "DownIn" && S > H)
      knockedIn = false;

    if (params.barrierType == "UpOut" || params.barrierType == "DownOut")
      return knockedOut ? 0.0 : intrinsic;
    else
      return knockedIn ? intrinsic : 0.0;
  }

  double sqrtT = std::sqrt(T);
  double mu = (r - q - 0.5 * v * v) / (v * v);
  double lambda = std::sqrt(mu * mu + 2.0 * r / (v * v));
  double z = std::log(H / S) / (v * sqrtT) + lambda * v * sqrtT;

  // Helper terms for Merton's barrier formulas
  double x1 = std::log(S / K) / (v * sqrtT) + (1.0 + mu) * v * sqrtT;
  double x2 = std::log(S / H) / (v * sqrtT) + (1.0 + mu) * v * sqrtT;
  double y1 = std::log(H * H / (S * K)) / (v * sqrtT) + (1.0 + mu) * v * sqrtT;
  double y2 = std::log(H / S) / (v * sqrtT) + (1.0 + mu) * v * sqrtT;

  double ert = std::exp(-r * T);
  double eqt = std::exp(-q * T);

  double phi = 1.0; // +1 for call, -1 for put
  bool isCall = (params.type == "Call" || params.type == "call");
  if (!isCall)
    phi = -1.0;

  // Ratio (H/S)^(2*(mu+1))
  double HS_pow = std::pow(H / S, 2.0 * (mu + 1.0));

  // The six standard terms (A through F) of Merton's barrier formula
  double A = phi * S * eqt * normalCDF(phi * x1) -
             phi * K * ert * normalCDF(phi * (x1 - v * sqrtT));

  double B = phi * S * eqt * normalCDF(phi * x2) -
             phi * K * ert * normalCDF(phi * (x2 - v * sqrtT));

  double C = phi * S * eqt * HS_pow * normalCDF(-phi * y1) -
             phi * K * ert * std::pow(H / S, 2.0 * mu) *
                 normalCDF(-phi * (y1 - v * sqrtT));

  double D = phi * S * eqt * HS_pow * normalCDF(-phi * y2) -
             phi * K * ert * std::pow(H / S, 2.0 * mu) *
                 normalCDF(-phi * (y2 - v * sqrtT));

  // Knock-out price based on barrier type and option type
  double knockOutPrice = 0.0;

  if (isCall) {
    if (params.barrierType == "DownOut" || params.barrierType == "DownIn") {
      // Down barrier call
      if (H <= K) {
        knockOutPrice = A - C; // down-and-out call when H <= K
      } else {
        knockOutPrice = B - D; // down-and-out call when H > K
      }
    } else {
      // Up barrier call
      if (H <= K) {
        knockOutPrice = 0.0; // barrier below strike, always knocked out for up
      } else {
        knockOutPrice = A - B + D; // up-and-out call when H > K
      }
    }
  } else {
    // Put
    if (params.barrierType == "DownOut" || params.barrierType == "DownIn") {
      // Down barrier put
      if (H <= K) {
        knockOutPrice = -A + B + C - D; // down-and-out put when H <= K
      } else {
        knockOutPrice = 0.0; // H > K, barrier above strike for down put
      }
    } else {
      // Up barrier put
      if (H <= K) {
        knockOutPrice = -A + C; // up-and-out put when H <= K
      } else {
        knockOutPrice = -B + D; // up-and-out put when H > K
      }
    }
  }

  knockOutPrice = std::max(knockOutPrice, 0.0);

  // For knock-in, use in-out parity: KnockIn = Vanilla - KnockOut
  if (params.barrierType == "UpIn" || params.barrierType == "DownIn") {
    // Compute vanilla price
    OptionParams vanillaParams = params;
    vanillaParams.barrierType = "None";
    Greeks vanillaGreeks = calculateVanilla(S, vanillaParams);
    return std::max(vanillaGreeks.price, 0.0) - knockOutPrice;
  }

  return knockOutPrice;
}

// --- Main calculate: dispatches to vanilla or barrier, applies multiplier ---
Greeks BlackScholes::calculate(double S, const OptionParams &params) {
  bool hasBarrier = !params.barrierType.empty() && params.barrierType != "None";

  if (!hasBarrier) {
    // Pure vanilla path
    Greeks greeks = calculateVanilla(S, params);

    double multiplier = (params.position == "Short" ||
                         params.position == "short" || params.position == "-1")
                            ? -1.0
                            : 1.0;
    double totalMult = multiplier * params.quantity;

    greeks.price *= totalMult;
    greeks.delta *= totalMult;
    greeks.gamma *= totalMult;
    greeks.theta *= totalMult;
    greeks.vega *= totalMult;
    greeks.rho *= totalMult;
    greeks.payoff *= totalMult;
    greeks.timeValue *= totalMult;
    greeks.speed *= totalMult;
    greeks.zomma *= totalMult;
    greeks.color *= totalMult;
    greeks.ultima *= totalMult;

    return greeks;
  }

  // --- Barrier option path ---
  // Price via closed-form, Greeks via finite-difference bumps
  Greeks greeks = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                   0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0};

  double price = barrierPrice(S, params);
  greeks.price = price;

  // Payoff for barrier at current spot
  bool isCall = (params.type == "Call" || params.type == "call");
  double vanillaPayoff = isCall ? std::max(S - params.strike, 0.0)
                                : std::max(params.strike - S, 0.0);
  // For barrier payoff, check if barrier is breached
  bool active = true;
  if (params.barrierType == "UpOut" && S >= params.barrierLevel)
    active = false;
  if (params.barrierType == "DownOut" && S <= params.barrierLevel)
    active = false;
  if (params.barrierType == "UpIn")
    active = (S >= params.barrierLevel);
  if (params.barrierType == "DownIn")
    active = (S <= params.barrierLevel);
  greeks.payoff = active ? vanillaPayoff : 0.0;
  greeks.timeValue = price - greeks.payoff;

  // Finite-difference Greeks
  double dS = S * 0.001;
  if (dS < 0.0001)
    dS = 0.0001;

  double priceUp = barrierPrice(S + dS, params);
  double priceDown = barrierPrice(S - dS, params);

  greeks.delta = (priceUp - priceDown) / (2.0 * dS);
  greeks.gamma = (priceUp - 2.0 * price + priceDown) / (dS * dS);

  // Speed (3rd deriv w.r.t. S)
  double dS3 = S * 0.002;
  if (dS3 < 0.0002)
    dS3 = 0.0002;
  double p2u = barrierPrice(S + 2.0 * dS3, params);
  double p1u = barrierPrice(S + dS3, params);
  double p1d = barrierPrice(S - dS3, params);
  double p2d = barrierPrice(S - 2.0 * dS3, params);
  greeks.speed = (p2u - 2.0 * p1u + 2.0 * p1d - p2d) / (2.0 * dS3 * dS3 * dS3);

  // Theta (bump T)
  double dT = 1.0 / 365.0;
  if (params.timeToMaturity > dT) {
    OptionParams pT = params;
    pT.timeToMaturity -= dT;
    greeks.theta = (barrierPrice(S, pT) - price) / dT;
  }

  // Vega (bump vol)
  double dv = 0.001;
  OptionParams pVu = params;
  pVu.volatility += dv;
  OptionParams pVd = params;
  pVd.volatility -= dv;
  double priceVu = barrierPrice(S, pVu);
  double priceVd = barrierPrice(S, pVd);
  greeks.vega = (priceVu - priceVd) / (2.0 * dv);

  // Rho (bump r)
  double dr = 0.0001;
  OptionParams pRu = params;
  pRu.riskFreeRate += dr;
  OptionParams pRd = params;
  pRd.riskFreeRate -= dr;
  greeks.rho = (barrierPrice(S, pRu) - barrierPrice(S, pRd)) / (2.0 * dr);

  // Zomma (d(gamma)/d(vol))
  double gammaVu =
      (barrierPrice(S + dS, pVu) - 2.0 * priceVu + barrierPrice(S - dS, pVu)) /
      (dS * dS);
  double gammaVd =
      (barrierPrice(S + dS, pVd) - 2.0 * priceVd + barrierPrice(S - dS, pVd)) /
      (dS * dS);
  greeks.zomma = (gammaVu - gammaVd) / (2.0 * dv);

  // Color (d(gamma)/d(t))
  if (params.timeToMaturity > dT) {
    OptionParams pTm = params;
    pTm.timeToMaturity -= dT;
    double priceTm = barrierPrice(S, pTm);
    double gammaTm = (barrierPrice(S + dS, pTm) - 2.0 * priceTm +
                      barrierPrice(S - dS, pTm)) /
                     (dS * dS);
    greeks.color = (gammaTm - greeks.gamma) / dT;
  }

  // Vanna (d(delta)/d(vol))
  double deltaVu =
      (barrierPrice(S + dS, pVu) - barrierPrice(S - dS, pVu)) / (2.0 * dS);
  double deltaVd =
      (barrierPrice(S + dS, pVd) - barrierPrice(S - dS, pVd)) / (2.0 * dS);
  greeks.vanna = (deltaVu - deltaVd) / (2.0 * dv);

  // Volga (d(vega)/d(vol)) = second derivative of price w.r.t. vol
  greeks.volga = (priceVu - 2.0 * price + priceVd) / (dv * dv);

  // Ultima (d^2(vega)/d(vol)^2) = 3rd derivative of price w.r.t vol
  double dv3 = 0.002;
  OptionParams p2Vu = params;
  p2Vu.volatility += 2.0 * dv3;
  OptionParams p1Vu = params;
  p1Vu.volatility += dv3;
  OptionParams p1Vd = params;
  p1Vd.volatility -= dv3;
  OptionParams p2Vd = params;
  p2Vd.volatility -= 2.0 * dv3;

  double price2Vu = barrierPrice(S, p2Vu);
  double price1Vu = barrierPrice(S, p1Vu);
  double price1Vd = barrierPrice(S, p1Vd);
  double price2Vd = barrierPrice(S, p2Vd);
  greeks.ultima = (price2Vu - 2.0 * price1Vu + 2.0 * price1Vd - price2Vd) /
                  (2.0 * dv3 * dv3 * dv3);

  // Apply position multiplier
  double multiplier = (params.position == "Short" ||
                       params.position == "short" || params.position == "-1")
                          ? -1.0
                          : 1.0;
  double totalMult = multiplier * params.quantity;

  greeks.price *= totalMult;
  greeks.delta *= totalMult;
  greeks.gamma *= totalMult;
  greeks.theta *= totalMult;
  greeks.vega *= totalMult;
  greeks.rho *= totalMult;
  greeks.payoff *= totalMult;
  greeks.timeValue *= totalMult;
  greeks.speed *= totalMult;
  greeks.zomma *= totalMult;
  greeks.color *= totalMult;
  greeks.ultima *= totalMult;
  greeks.vanna *= totalMult;
  greeks.volga *= totalMult;

  return greeks;
}
