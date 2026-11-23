/**
 * The Node coordinator in a process of its own, for ./load.ts: so that the CPU time it uses can
 * be read apart from the load generator's. Says "up" over IPC once it listens.
 *
 * Owner: E-coordinator. Not used outside measurements.
 */
import { startNodeCoordinator } from "./node";
import { ADMISSION_SECRET, SERVER_SECRET } from "./testkit";

const port = Number(process.argv[2] ?? 4264);
await startNodeCoordinator({ port, admissionSecret: ADMISSION_SECRET, serverSecret: SERVER_SECRET, viewerCap: 100_000, seed: 1 });
process.send?.("up");
