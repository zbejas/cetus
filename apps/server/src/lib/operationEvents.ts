type OperationFinishedListener = (operationId: string, status: string) => void;

const listeners = new Set<OperationFinishedListener>();

export function onOperationFinished(listener: OperationFinishedListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitOperationFinished(operationId: string, status: string) {
  for (const listener of listeners) {
    try {
      listener(operationId, status);
    } catch (error) {
      console.error("[cetus] operation finished listener failed", error);
    }
  }
}
