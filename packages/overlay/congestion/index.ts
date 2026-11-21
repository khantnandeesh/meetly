/**
 * congestion's public face. Owner: E-congestion. See ./README.md.
 */
import { notImplemented } from "../runtime";
import type { LayerGate, LayerGateOptions, LinkEstimator, SourceRateController, SourceRateOptions, UplinkProbe } from "./types";

export type * from "./types";

export const createLinkEstimator: () => LinkEstimator = () => notImplemented("E-congestion", "congestion.createLinkEstimator");

export const createLayerGate: (options: LayerGateOptions) => LayerGate = () => notImplemented("E-congestion", "congestion.createLayerGate");

export const createSourceRateController: (options: SourceRateOptions) => SourceRateController = () =>
  notImplemented("E-congestion", "congestion.createSourceRateController");

export const createUplinkProbe: (options: { targetKbps: number; durationMs: number }) => UplinkProbe = () =>
  notImplemented("E-congestion", "congestion.createUplinkProbe");
