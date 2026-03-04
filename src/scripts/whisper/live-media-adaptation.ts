import type { DeviceClass, MediaAdaptationSnapshot, MediaTier, NetworkClass } from "./live-media-types";

export interface AdaptationInput {
  rttMs: number;
  packetLoss: number;
  cpuPressure: number;
}

export function classifyNetwork(input: AdaptationInput): NetworkClass {
  if (input.packetLoss > 0.18 || input.rttMs > 900) return "poor";
  if (input.packetLoss > 0.1 || input.rttMs > 550) return "constrained";
  if (input.packetLoss > 0.05 || input.rttMs > 250) return "moderate";
  if (input.packetLoss > 0.02 || input.rttMs > 120) return "good";
  return "excellent";
}

export function chooseTier(networkClass: NetworkClass, deviceClass: DeviceClass, cpuPressure = 0): MediaTier {
  if (networkClass === "poor") return "P0";
  if (networkClass === "constrained" || cpuPressure > 0.9) return "P1";
  if (networkClass === "moderate" || deviceClass === "low" || cpuPressure > 0.75) return "P2";
  if (networkClass === "good" || deviceClass === "medium" || cpuPressure > 0.5) return "P3";
  return "P4";
}

export function nextAdaptationSnapshot(input: AdaptationInput, deviceClass: DeviceClass): MediaAdaptationSnapshot {
  const networkClass = classifyNetwork(input);
  const tier = chooseTier(networkClass, deviceClass, input.cpuPressure);
  const reason: MediaAdaptationSnapshot["reason"] = input.cpuPressure > 0.8
    ? "cpu-pressure"
    : input.packetLoss > 0.08
      ? "loss-spike"
      : input.rttMs > 300
        ? "rtt-spike"
        : "recover-stable";
  return { networkClass, deviceClass, tier, reason };
}
