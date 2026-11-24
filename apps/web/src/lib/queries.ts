import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type UserUpdateInput } from "./api";
import type { RegistryCredentialInput, StackMetadata } from "@shared/types";

export const queryKeys = {
  me: ["me"] as const,
  dashboard: ["dashboard"] as const,
  hosts: ["hosts"] as const,
  host: (id: string) => ["host", id] as const,
  inventory: (id: string) => ["inventory", id] as const,
  stacks: (query = "") => ["stacks", query] as const,
  stack: (id: string) => ["stack", id] as const,
  operations: ["operations"] as const,
  operation: (id: string) => ["operation", id] as const,
  updateQueue: ["update-queue"] as const,
  audit: (stackId?: string) => ["audit", stackId ?? "all"] as const,
  keys: ["keys"] as const,
  users: ["users"] as const,
  invites: ["invites"] as const,
  invite: (token: string) => ["invite", token] as const,
  settings: ["settings"] as const,
  registries: ["registries"] as const,
  backups: ["backups"] as const,
  authConfig: ["auth-config"] as const,
  notificationChannels: ["notification-channels"] as const,
  notificationDeliveries: ["notification-deliveries"] as const,
};

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, retry: false, staleTime: 30_000 });
}

export function useLogSources() {
  return useQuery({
    queryKey: ["log-sources"],
    queryFn: api.logSources,
    refetchInterval: 15_000,
  });
}

export function useDashboard() {
  return useQuery({ queryKey: queryKeys.dashboard, queryFn: api.dashboard, refetchInterval: 8_000 });
}

export function useHosts() {
  return useQuery({ queryKey: queryKeys.hosts, queryFn: api.hosts, refetchInterval: 10_000 });
}

export function useHost(id: string) {
  return useQuery({ queryKey: queryKeys.host(id), queryFn: () => api.host(id), enabled: Boolean(id) });
}

export function useUpdateWorker() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.updateWorker,
    onSuccess: (operation) => {
      client.invalidateQueries({ queryKey: queryKeys.hosts });
      client.invalidateQueries({ queryKey: queryKeys.host(operation.hostId ?? "") });
      client.invalidateQueries({ queryKey: queryKeys.operations });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdateAllWorkers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.updateAllWorkers,
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: queryKeys.hosts });
      for (const entry of result.started) {
        client.invalidateQueries({ queryKey: queryKeys.host(entry.hostId) });
      }
      client.invalidateQueries({ queryKey: queryKeys.operations });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useInventory(id: string) {
  return useQuery({ queryKey: queryKeys.inventory(id), queryFn: () => api.inventory(id), enabled: Boolean(id), refetchInterval: 12_000 });
}

export function useStacks(query = "") {
  return useQuery({ queryKey: queryKeys.stacks(query), queryFn: () => api.stacks(query), refetchInterval: 8_000 });
}

export function useStack(id: string) {
  return useQuery({ queryKey: queryKeys.stack(id), queryFn: () => api.stack(id), enabled: Boolean(id), refetchInterval: 5_000 });
}

export function useOperations() {
  return useQuery({ queryKey: queryKeys.operations, queryFn: api.operations, refetchInterval: 3_000 });
}

export function useOperation(id: string | null) {
  return useQuery({
    queryKey: queryKeys.operation(id ?? ""),
    queryFn: () => api.operation(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && (data.status === "success" || data.status === "failed") ? false : 700;
    },
  });
}

export function useAudit(stackId?: string) {
  return useQuery({ queryKey: queryKeys.audit(stackId), queryFn: () => api.audit({ stackId, limit: 100 }), refetchInterval: 8_000 });
}

export function useKeys() {
  return useQuery({ queryKey: queryKeys.keys, queryFn: api.keys });
}

export function useUsers() {
  return useQuery({ queryKey: queryKeys.users, queryFn: api.users });
}

export function useInvites() {
  return useQuery({ queryKey: queryKeys.invites, queryFn: api.invites });
}

export function useCreateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createUser,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.users });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useUpdateUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserUpdateInput }) => api.updateUser(id, body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.users });
      client.invalidateQueries({ queryKey: queryKeys.me });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteUser,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.users });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useCreateInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createInvite,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.invites });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useRevokeInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.revokeInvite,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.invites });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useInvite(token: string) {
  return useQuery({
    queryKey: queryKeys.invite(token),
    queryFn: () => api.invite(token),
    retry: false,
    enabled: Boolean(token),
  });
}

export function useSettings(enabled = true) {
  return useQuery({ queryKey: queryKeys.settings, queryFn: api.settings, enabled });
}

export function useBackups() {
  return useQuery({ queryKey: queryKeys.backups, queryFn: api.backups, refetchInterval: 15_000 });
}

export function useCreateBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createBackup,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.backups });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useRestoreBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.restoreBackup,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.backups });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useDeleteBackup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteBackup,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.backups });
      client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

export function useAuthConfig() {
  return useQuery({ queryKey: queryKeys.authConfig, queryFn: api.authConfig, staleTime: 30_000 });
}

export function useNotificationChannels(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notificationChannels,
    queryFn: api.notificationChannels,
    enabled,
  });
}

export function useNotificationDeliveries(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notificationDeliveries,
    queryFn: () => api.notificationDeliveries(30),
    enabled,
    refetchInterval: 15_000,
  });
}

export function useCreateNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createNotificationChannel,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.notificationChannels });
      client.invalidateQueries({ queryKey: queryKeys.notificationDeliveries });
    },
  });
}

export function useUpdateNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateNotificationChannel>[1] }) =>
      api.updateNotificationChannel(id, body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.notificationChannels });
      client.invalidateQueries({ queryKey: queryKeys.notificationDeliveries });
    },
  });
}

export function useDeleteNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteNotificationChannel,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.notificationChannels });
      client.invalidateQueries({ queryKey: queryKeys.notificationDeliveries });
    },
  });
}

export function useScanStacks() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.scan,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["stacks"] });
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useCreateStack() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, compose }: { name: string; compose: string }) => api.createStack(name, compose),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["stacks"] });
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useSaveStack(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { compose?: string; env?: string; metadata?: StackMetadata; baseHash?: string }) => api.saveStack(id, body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.stack(id) });
      client.invalidateQueries({ queryKey: ["stacks"] });
    },
  });
}

export function useStackAction(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: string; body?: { profiles?: string[]; confirmName?: string } }) =>
      api.stackAction(id, action, body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.stack(id) });
      client.invalidateQueries({ queryKey: ["stacks"] });
      client.invalidateQueries({ queryKey: queryKeys.operations });
    },
  });
}

export function useCheckUpdates(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.checkUpdates(id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.stack(id) });
      client.invalidateQueries({ queryKey: ["stacks"] });
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useCheckAllUpdates() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.checkAllUpdates,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
      client.invalidateQueries({ queryKey: ["stacks"] });
    },
  });
}

export function useApplyAllUpdates() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.applyAllUpdates,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
      client.invalidateQueries({ queryKey: ["stacks"] });
      client.invalidateQueries({ queryKey: queryKeys.operations });
      client.invalidateQueries({ queryKey: queryKeys.updateQueue });
    },
  });
}

export function useUpdateQueue() {
  return useQuery({
    queryKey: queryKeys.updateQueue,
    queryFn: api.updateQueue,
    refetchInterval: 4_000,
  });
}

export function useReorderUpdateQueue() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.reorderUpdateQueue,
    onSuccess: (view) => client.setQueryData(queryKeys.updateQueue, view),
  });
}

export function useRemoveUpdateQueueEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.removeUpdateQueueEntry,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.updateQueue });
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.settings });
      client.invalidateQueries({ queryKey: queryKeys.dashboard });
      client.invalidateQueries({ queryKey: ["stacks"] });
    },
  });
}

export function useRegistries() {
  return useQuery({ queryKey: queryKeys.registries, queryFn: api.registries });
}

export function useSaveRegistry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; body: RegistryCredentialInput | Partial<RegistryCredentialInput> }) =>
      input.id
        ? api.updateRegistry(input.id, input.body)
        : api.createRegistry(input.body as RegistryCredentialInput),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.registries });
    },
  });
}

export function useDeleteRegistry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteRegistry,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.registries });
    },
  });
}

export function useRestoreSnapshot(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: string) => api.restoreSnapshot(id, file),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.stack(id) });
      client.invalidateQueries({ queryKey: queryKeys.operations });
    },
  });
}

export function useCreateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createKey,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

export function useRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.revokeKey,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

export function useDeleteKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteKey,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}

export function usePruneRevokedKeys() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.pruneRevokedKeys,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.keys }),
  });
}
