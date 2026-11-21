/**
 * congestion's public face. Owner: E-congestion. See ./README.md.
 */
import { notImplemented } from "../runtime";
import { createLinkEstimator as linkEstimator, type LinkEstimatorOptions } from "./estimator";
import type { LayerGate, LayerGateOptions, LinkEstimator, SourceRateController, SourceRateOptions, UplinkProbe } from "./types";

export type * from "./types";
export type { LinkEstimatorOptions } from "./estimator";
export { DEFAULT_STREAM_KBPS, ESTIMATOR_TUNING, GATE_TUNING, SOURCE_RATE_TUNING, bytesOf } from "./tuning";
export type { EstimatorTuning, GateTuning, SourceRateTuning } from "./tuning";

/** `options.bitrateKbps` is *B* of SPEC §11.2; without it, stage 1's 1,200 kbps. */
export const createLinkEstimator: (options?: LinkEstimatorOptions) => LinkEstimator = linkEstimator;

export const createLayerGate: (options: LayerGateOptions) => LayerGate = () => notImplemented("E-congestion", "congestion.createLayerGate");

export const createSourceRateController: (options: SourceRateOptions) => SourceRateController = () =>
  notImplemented("E-congestion", "congestion.createSourceRateController");

export const createUplinkProbe: (options: { targetKbps: number; durationMs: number }) => UplinkProbe = () =>
  notImplemented("E-congestion", "congestion.createUplinkProbe");
