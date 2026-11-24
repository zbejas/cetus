export interface SelfUpdateScriptInput {
  operationId: string;
  containerId: string;
  dir: string;
  projectName: string;
  serviceName: string;
  imageRef: string;
  backupTag: string;
  statusFile: string;
  logFile: string;
  services?: string[];
  healthGraceSeconds: number;
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function selfUpdateBackupTag(operationId: string) {
  return `cetus-self-update:${operationId}`;
}

export function buildSelfUpdateScript(input: SelfUpdateScriptInput) {
  const quote = shellQuote;
  const pullTargets = input.services?.length ? ` ${input.services.map(quote).join(" ")}` : "";
  return `set -u
OUT=${quote(input.logFile)}
STATUS=${quote(input.statusFile)}
: > "$OUT"
finish() {
  code=$1
  status=$2
  printf '{"operationId":"${input.operationId}","status":"%s","exitCode":%s}\\n' "$status" "$code" > "$STATUS"
  exit "$code"
}
docker tag ${quote(input.imageRef)} ${quote(input.backupTag)} >> "$OUT" 2>&1 || finish 1 failed
cd ${quote(input.dir)} >> "$OUT" 2>&1 || finish 1 failed
docker compose -p ${quote(input.projectName)} pull${pullTargets} >> "$OUT" 2>&1 || finish $? failed
docker rm -f ${quote(input.containerId)} >> "$OUT" 2>&1 || true
docker compose -p ${quote(input.projectName)} up -d --remove-orphans >> "$OUT" 2>&1 || {
  echo "[cetus] compose up failed. Restoring the previous image." >> "$OUT"
  docker tag ${quote(input.backupTag)} ${quote(input.imageRef)} >> "$OUT" 2>&1 || true
  docker compose -p ${quote(input.projectName)} up -d --force-recreate >> "$OUT" 2>&1 || true
  finish 1 failed
}
for i in $(seq 1 ${Math.max(10, Math.min(input.healthGraceSeconds, 600))}); do
  cid=$(docker compose -p ${quote(input.projectName)} ps -q ${quote(input.serviceName)} 2>/dev/null | head -n 1)
  if [ -n "$cid" ]; then
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
    if [ "$health" = "healthy" ] || [ "$health" = "running" ]; then
      finish 0 success
    fi
  fi
  sleep 1
done
echo "[cetus] New container did not become healthy. Restoring the previous image." >> "$OUT"
docker tag ${quote(input.backupTag)} ${quote(input.imageRef)} >> "$OUT" 2>&1 || true
docker compose -p ${quote(input.projectName)} up -d --force-recreate >> "$OUT" 2>&1 || true
finish 1 failed
`;
}

export function startSelfUpdateHelper(input: {
  helperName: string;
  containerId: string;
  imageRef: string;
  dockerConfig: string;
  env?: Record<string, string>;
  script: string;
}): { ok: true } | { ok: false; error: string } {
  const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const result = Bun.spawnSync([
    "docker",
    "run",
    "--rm",
    "-d",
    "--name",
    input.helperName,
    "--volumes-from",
    input.containerId,
    "-e",
    `DOCKER_CONFIG=${input.dockerConfig}`,
    ...envArgs,
    "--entrypoint",
    "sh",
    input.imageRef,
    "-lc",
    input.script,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: result.stderr.toString().trim() || result.stdout.toString().trim() || "The helper container did not start.",
  };
}

export function removeSelfUpdateTag(tag: string | undefined) {
  if (!tag) return;
  Bun.spawnSync(["docker", "rmi", tag], { stdout: "pipe", stderr: "pipe" });
}
