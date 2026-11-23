// Live (beta) behind TURN (SPEC §8.1, §6.7 [D82]): the coordinator's own tests, run here as well so
// that CI's `npm test`, which runs test/**, covers them. They live with the coordinator's others.
import "../packages/overlay/coordinator/turn.test";
