import { describe, expect, it } from "vitest";

import { CLI_NAME, CLI_VERSION, PIPELINE_STAGES, run } from "../src/cli/index.js";

describe("cli skeleton", () => {
  it("prints help and exits 0 when asked", () => {
    const result = run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: ${CLI_NAME}`);
    for (const stage of PIPELINE_STAGES) {
      expect(result.stdout).toContain(stage);
    }
  });

  it("prints the version and exits 0", () => {
    const result = run(["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`${CLI_NAME} ${CLI_VERSION}`);
  });

  it("fails closed on an unknown command", () => {
    const result = run(["definitely-not-a-command"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command");
  });

  it("names the four pipeline stages in order", () => {
    expect(PIPELINE_STAGES.map((stage) => stage.split(/\s+/)[0])).toEqual([
      "source",
      "ir",
      "emit",
      "deploy",
    ]);
  });
});
