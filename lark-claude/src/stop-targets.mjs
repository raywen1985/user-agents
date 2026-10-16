function unavailable(record, reason) {
  return { ...record, stopCapability: Object.freeze({ ready: false, reason }) };
}

function sameGatewayAggregate(candidate, record) {
  if (record.nativeId) return candidate.agent === record.agent && candidate.nativeId === record.nativeId;
  const ids = new Set([record.gatewayId, record.sessionId, ...(record.gatewayIds || [])].filter(Boolean));
  return ids.has(candidate.gatewayId || candidate.sessionId);
}

export function createStopTargetDecorator({
  store,
  getGatewayActivities,
  exactClaude,
  probeClaude,
  exactCodex,
  codexControl,
}) {
  async function resolve(record) {
    let gatewayActivities;
    try { gatewayActivities = await getGatewayActivities(); } catch { return unavailable(record, "snapshot_incomplete"); }
    if (!Array.isArray(gatewayActivities)) return unavailable(record, "snapshot_incomplete");
    const gatewayMatches = gatewayActivities.filter((candidate) => sameGatewayAggregate(candidate, record));
    const gatewayIds = [...new Set(gatewayMatches.map((candidate) => candidate.gatewayId || candidate.sessionId).filter(Boolean))].sort();
    if (gatewayIds.length > 1) return unavailable(record, "ambiguous_control_owner");
    if (gatewayIds.length === 1) {
      const gatewayId = gatewayIds[0];
      const taskIds = [...new Set(gatewayMatches.filter((candidate) => (candidate.gatewayId || candidate.sessionId) === gatewayId)
        .map((candidate) => candidate.taskId).filter(Boolean))].sort();
      if (!taskIds.length) return unavailable(record, "snapshot_incomplete");
      const bound = store.createStopTarget({
        provider: "gateway", agent: record.agent, sessionId: gatewayId,
        nativeId: record.nativeId || null, gatewayId, taskIds,
      });
      return { ...record, stopRef: bound.stopRef, stopCapability: Object.freeze({ ready: true, reason: null }) };
    }

    if (record.agent === "claude") {
      if (!record.sourcePath || !record.nativeId || !record.pid || !record.procStart) return unavailable(record, "snapshot_incomplete");
      let exact;
      try {
        exact = await exactClaude({
          sourcePath: record.sourcePath, sessionId: record.nativeId, pid: record.pid, procStart: record.procStart,
        });
      } catch { return unavailable(record, "snapshot_incomplete"); }
      if (!exact.ok) return unavailable(record, exact.reason || "identity_changed");
      let processState;
      try { processState = await probeClaude({ sessionId: record.nativeId, pid: record.pid, procStart: record.procStart }); }
      catch { return unavailable(record, "provider_error"); }
      if (processState !== "live") return unavailable(record, processState === "reused" ? "identity_changed" : "already_finished");
      const bound = store.createStopTarget({
        provider: "claude", agent: "claude", sessionId: record.nativeId,
        pid: record.pid, procStart: record.procStart, sourcePath: exact.record.sourcePath,
      });
      return { ...record, stopRef: bound.stopRef, stopCapability: Object.freeze({ ready: true, reason: null }) };
    }

    if (!record.nativeId || !record.turnId) return unavailable(record, "snapshot_incomplete");
    let exact;
    try { exact = await exactCodex({ threadId: record.nativeId }); }
    catch { return unavailable(record, "snapshot_incomplete"); }
    if (!exact || exact.turnId !== record.turnId || exact.status !== "inProgress") return unavailable(record, "already_finished");
    const owner = await codexControl.probeExactOwner({ threadId: record.nativeId, turnId: record.turnId });
    if (!owner.ready) return unavailable(record, owner.reason || "control_unreachable");
    owner.connection?.close?.();
    const bound = store.createStopTarget({
      provider: "codex", agent: "codex", sessionId: record.nativeId,
      endpointId: owner.endpointId, turnId: record.turnId,
    });
    return { ...record, stopRef: bound.stopRef, stopCapability: Object.freeze({ ready: true, reason: null }) };
  }

  return async (records) => Promise.all(records.map(resolve));
}
