/**
 * Who may relay, and what a parent costs (SPEC §8), as the coordinator's placement needs them.
 *
 * Both are topology's (`judgeRelay`, `parentCost` in ../topology/index, PLAN T2): the only code
 * this module imports from another (PLAN §4), so that the coordinator and every peer judge and
 * rank the same way. `CoordinatorCoreOptions.scoring` can replace them in a test.
 *
 * Owner: E-coordinator.
 */
import { judgeRelay, parentCost } from "../topology/index";
import type { JudgeRelay, ParentCost } from "../topology/types";

export type Scoring = { judgeRelay: JudgeRelay; parentCost: ParentCost };

export const scoring = (): Scoring => ({ judgeRelay, parentCost });
