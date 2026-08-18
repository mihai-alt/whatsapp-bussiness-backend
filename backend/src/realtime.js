let io = null;

export function setIO(socketIo) {
  io = socketIo;
}

export function getIO() {
  return io;
}

export function emitCampaignProgress(campaignId, payload) {
  io?.to(`campaign:${campaignId}`).emit('campaign:progress', { campaignId, ...payload });
  io?.emit('campaign:progress', { campaignId, ...payload });
}

export function emitToUser(userId, event, payload) {
  if (!userId) return;
  io?.to(`user:${userId}`).emit(event, payload);
}

/**
 * Broadcast a workspace directory change to all authenticated clients.
 * resource: 'contacts' | 'groups' | 'campaigns' | 'templates' | 'users' | ...
 * action: 'created' | 'updated' | 'deleted' | 'shared' | 'unshared' | 'imported' | ...
 */
export function emitWorkspaceChanged({
  resource,
  action,
  actorUserId = null,
  entityId = null,
  meta = null,
} = {}) {
  if (!resource || !action) return;
  const payload = {
    resource: String(resource),
    action: String(action),
    actorUserId: actorUserId != null ? Number(actorUserId) : null,
    entityId: entityId != null ? entityId : null,
    meta: meta || null,
    at: new Date().toISOString(),
  };
  try {
    io?.to('workspace').emit('workspace:changed', payload);
    // Fallback for sockets that authenticated before workspace join existed
    io?.emit('workspace:changed', payload);
  } catch {
    /* socket may not be ready */
  }
}
