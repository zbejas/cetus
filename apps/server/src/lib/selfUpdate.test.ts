import { describe, expect, test } from "bun:test";
import { buildSelfUpdateScript, selfUpdateBackupTag } from "./selfUpdate.ts";

describe("self-update helper script", () => {
  test("tags the running image before pulling and restores it on failure", () => {
    const script = buildSelfUpdateScript({
      operationId: "op-1",
      containerId: "container-1",
      dir: "/opt/stacks/cetus",
      projectName: "cetus",
      serviceName: "cetus",
      imageRef: "ghcr.io/zbejas/cetus:latest",
      backupTag: selfUpdateBackupTag("op-1"),
      statusFile: "/data/status.json",
      logFile: "/data/update.log",
      healthGraceSeconds: 90,
    });
    expect(script).toContain("docker tag 'ghcr.io/zbejas/cetus:latest' 'cetus-self-update:op-1'");
    expect(script).toContain("docker rm -f 'container-1'");
    expect(script).toContain("docker compose -p 'cetus' pull");
    expect(script).toContain("docker tag 'cetus-self-update:op-1' 'ghcr.io/zbejas/cetus:latest'");
    expect(script).toContain('"operationId":"op-1"');
  });

  test("quotes single quotes in paths", () => {
    const script = buildSelfUpdateScript({
      operationId: "op-2",
      containerId: "container-2",
      dir: "/opt/stack's/cetus",
      projectName: "cetus",
      serviceName: "cetus",
      imageRef: "image:tag",
      backupTag: "backup:tag",
      statusFile: "/data/status.json",
      logFile: "/data/update.log",
      healthGraceSeconds: 10,
    });
    expect(script).toContain("/opt/stack'\\''s/cetus");
  });
});
