export type Role = "admin" | "operator" | "viewer";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  image?: string | null;
}

export interface Actor {
  type: "user" | "key";
  id: string;
  name: string;
  role: Role | "key";
  scopes: string[];
  keyId?: string;
}

export type HostStatus = "online" | "offline" | "degraded";

export interface HostSummary {
  id: string;
  name: string;
  slug: string;
  kind: "local" | "worker";
  localAddress?: string | null;
  status: HostStatus;
  cetusVersion: string | null;
  workerUpdateAvailable: boolean;
  workerUpdateSupported: boolean;
  dockerVersion: string | null;
  os: string | null;
  arch: string | null;
  cpus: number | null;
  memory: number | null;
  lastSeenAt: string | null;
  stackCount: number;
  runningStacks: number;
  containerCount: number;
  imageCount: number;
  cpuUsage: number | null;
  memoryUsed: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
}

export type StackStatus =
  | "running"
  | "partial"
  | "stopped"
  | "created"
  | "error"
  | "unknown"
  | "updating";

export interface AutoUpdateConfig {
  enabled: boolean;
  cron: string;
  timezone: string;
  services?: string[];
  excludeServices?: string[];
  healthCheck?: boolean;
  rollback?: boolean;
  healthGraceSeconds?: number;
}

export type AutoUpdateSource = "global" | "custom" | "off";

export interface StackMetadata {
  displayName?: string;
  description?: string;
  tags?: string[];
  icon?: string;
  urls?: { label: string; url: string }[];
  projectName?: string;
  autoUpdate?: AutoUpdateConfig;
}

export interface StackSummary {
  id: string;
  hostId: string;
  hostName: string;
  hostKind: HostSummary["kind"];
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  icon: string | null;
  status: StackStatus;
  composeFile: string;
  projectName: string;
  dir: string;
  serviceCount: number;
  runningCount: number;
  updatedAt: string;
  lastDeployedAt: string | null;
  updateAvailable: boolean;
}

export interface ServiceState {
  name: string;
  image: string;
  state: "running" | "exited" | "created" | "paused" | "restarting" | "dead" | "unknown";
  health: "healthy" | "unhealthy" | "starting" | "none";
  status: string;
  ports: { published: string; target: string; protocol: string; url?: string }[];
  containerId: string | null;
  containerName: string | null;
  cpu: number | null;
  memoryUsed: number | null;
  memoryLimit: number | null;
  uptime: string | null;
  oneShot: boolean;
}

export interface SnapshotInfo {
  file: string;
  hash: string;
  size: number;
  createdAt: string;
}

export interface AutoUpdateState {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastOperationId: string | null;
}

export interface UpdateCheckService {
  service: string;
  image: string;
  currentDigest: string | null;
  latestDigest: string | null;
  updateAvailable: boolean;
  autoUpdateDisabled?: boolean;
  error?: string;
}

export interface UpdateCheckResult {
  checkedAt: string;
  available: boolean;
  services: UpdateCheckService[];
}

export interface FleetUpdateCheckSummary {
  checked: number;
  failed: number;
  unchecked: number;
  updates: number;
  checkedAt: string;
  results: {
    stackId: string;
    stackName: string;
    available: boolean;
    checkedAt: string | null;
    error: string | null;
  }[];
}

export interface StackDetail extends StackSummary {
  compose: string;
  env: string;
  envRedacted?: boolean;
  composeHash: string;
  envHash: string;
  metadata: StackMetadata;
  services: ServiceState[];
  snapshots: SnapshotInfo[];
  profiles: string[];
  host: HostSummary;
  autoUpdateState?: AutoUpdateState;
  updateCheck?: UpdateCheckResult | null;
  globalAutoUpdate?: AutoUpdateConfig;
  effectiveAutoUpdate?: AutoUpdateConfig | null;
  autoUpdateSource?: AutoUpdateSource;
}

export type OperationType =
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "down"
  | "update"
  | "save"
  | "delete"
  | "scan";

export type OperationStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export interface Operation {
  id: string;
  type: OperationType;
  status: OperationStatus;
  stackId: string | null;
  stackName: string | null;
  hostId: string | null;
  actorName: string;
  output: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BackupSummary {
  id: string;
  filename: string;
  size: number;
  status: "creating" | "complete" | "failed";
  error: string | null;
  actorName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AuditEntry {
  id: string;
  actorType: string;
  actorName: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  hostId: string | null;
  stackId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  hostIds: string[];
  stackIds: string[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreated extends ApiKeySummary {
  secret: string;
}

export interface DashboardData {
  totals: {
    hosts: number;
    hostsOnline: number;
    stacks: number;
    running: number;
    unhealthy: number;
    containers: number;
    updates: number;
  };
  hosts: HostSummary[];
  recentStacks: StackSummary[];
  activity: AuditEntry[];
  updates: {
    stackId: string;
    stackName: string;
    hostName: string;
    image: string;
    currentDigest: string;
    latestDigest: string;
    service?: string;
    checkedAt?: string;
  }[];
  updatesCheckedAt?: string | null;
  updatesFailed?: number;
  globalAutoUpdate: AutoUpdateConfig;
}

export interface BulkUpdateResult {
  started: { stackId: string; stackName: string; operationId: string }[];
  queued: { stackId: string; stackName: string; queueId: string }[];
  skipped: { stackId: string; stackName: string; reason: string }[];
}

export type UpdateQueueStatus = "queued" | "running" | "success" | "failed" | "cancelled" | "skipped";

export interface UpdateQueueEntry {
  id: string;
  stackId: string;
  stackName: string;
  displayName: string;
  hostId: string;
  hostName: string;
  status: UpdateQueueStatus;
  position: number;
  trigger: "manual" | "bulk" | "queue" | "schedule";
  operationId: string | null;
  error: string | null;
  actorName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface UpdateQueueView {
  active: UpdateQueueEntry[];
  recent: UpdateQueueEntry[];
  pausedUntil: string | null;
}

export interface WorkerUpdateBulkResult {
  started: { hostId: string; hostName: string; operationId: string }[];
  skipped: { hostId: string; hostName: string; reason: string }[];
}

export interface RegistryCredentialHost {
  id: string;
  name: string;
  kind: HostSummary["kind"];
}

export interface RegistryCredentialSummary {
  id: string;
  registry: string;
  registryKey: string;
  username: string;
  hostIds: string[];
  hosts: RegistryCredentialHost[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryCredentialInput {
  registry: string;
  username: string;
  secret?: string;
  hostIds: string[];
  enabled?: boolean;
}

export interface DockerInfo {
  serverVersion: string;
  apiVersion: string;
  os: string;
  kernel: string;
  architecture: string;
  cpus: number;
  memory: number;
  dockerRootDir: string;
  driver: string;
  containers: number;
  containersRunning: number;
  containersPaused: number;
  containersStopped: number;
  images: number;
  warnings: string[] | null;
}

export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  runningFor: string;
  labels: Record<string, string>;
  project: string | null;
  service: string | null;
  stackId?: string | null;
  unmanaged: boolean;
}

export interface DockerImage {
  repository: string;
  tag: string;
  id: string;
  digest: string | null;
  size: string;
  createdSince: string;
  createdAt: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  createdAt: string;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ipv6: boolean;
  internal: boolean;
  createdAt: string;
}

export interface DockerDfRow {
  type: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

export interface HostInventory {
  host: HostSummary;
  info: DockerInfo | null;
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  df: DockerDfRow[];
  disk: { used: number; total: number; available: number } | null;
}

export interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface LogSource {
  id: string;
  name: string;
  names: string;
  image: string;
  state: string;
  status: string;
  project: string | null;
  service: string | null;
  unmanaged: boolean;
  hostId: string;
  hostName: string;
  hostKind: "local" | "worker";
  stackId: string | null;
  stackName: string | null;
  running: boolean;
}

export interface NotificationSummary {
  id: string;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}
