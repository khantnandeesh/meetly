/**
 * congestion's public face. Owner: E-congestion. See ./README.md.
 */
import { createLayerGate as layerGate } from "./gate";
import { createLinkEstimator as linkEstimator, type LinkEstimatorOptions } from "./estimator";
import { createUplinkProbe as uplinkProbe, type UplinkProbeOptions } from "./probe";
import { createSourceRateController as sourceRateController } from "./sourceRate";
import type { LayerGate, LayerGateOptions, LinkEstimator, SourceRateController, SourceRateOptions, UplinkProbe } from "./types";

export type * from "./types";
export type { LinkEstimatorOptions } from "./estimator";
export type { UplinkProbeOptions } from "./probe";
export { probeView } from "./probe";
export { DEFAULT_STREAM_KBPS, ESTIMATOR_TUNING, GATE_TUNING, PROBE_TUNING, SOURCE_RATE_TUNING, bytesOf } from "./tuning";
export type { EstimatorTuning, GateTuning, ProbeTuning, SourceRateTuning } from "./tuning";

/** `options.bitrateKbps` is *B* of SPEC §11.2; without it, stage 1's 1,200 kbps. */
export const createLinkEstimator: (options?: LinkEstimatorOptions) => LinkEstimator = linkEstimator;

export const createLayerGate: (options: LayerGateOptions) => LayerGate = layerGate;

export const createSourceRateController: (options: SourceRateOptions) => SourceRateController = sourceRateController;

export const createUplinkProbe: (options: UplinkProbeOptions) => UplinkProbe = uplinkProbe;
