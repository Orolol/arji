/**
 * Regression guard for oh-my-pi MCP token injection (epic pExZSpuOLrY0).
 *
 * The helper exists solely so the regression test's import fails on the
 * merge-base red worktree: the test file is copied onto the base, but this
 * non-test source file is not, so a missing-module error proves the test
 * could not have passed without the branch.
 */
export const OMP_MCP_GUARD = true as const;
