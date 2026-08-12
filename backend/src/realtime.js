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
