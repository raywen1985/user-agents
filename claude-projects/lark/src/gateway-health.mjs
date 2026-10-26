const WINDOWS_TO_UNIX_EPOCH_TICKS = 116444736000000000n;
const TICKS_PER_MILLISECOND = 10000n;

export function processStartFileTimeToIso(value) {
  if (typeof value !== "string" || !/^\d{10,20}$/.test(value)) {
    throw new Error("Invalid process FILETIME value");
  }
  const ticks = BigInt(value);
  if (ticks < WINDOWS_TO_UNIX_EPOCH_TICKS) throw new Error("Invalid process FILETIME range");
  const milliseconds = (ticks - WINDOWS_TO_UNIX_EPOCH_TICKS) / TICKS_PER_MILLISECOND;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid process FILETIME range");
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.getTime())) throw new Error("Invalid process FILETIME range");
  return date.toISOString();
}

export function buildGatewayHealth({ identity, listenerReady, updatedAt, state = {} }) {
  return {
    ...state,
    pid: identity.pid,
    procStart: identity.procStart,
    processStartedAt: identity.processStartedAt,
    installationGeneration: identity.installationGeneration,
    nodeExecutable: identity.nodeExecutable,
    gatewayEntry: identity.gatewayEntry,
    listenerReady: Boolean(listenerReady),
    updatedAt,
  };
}
