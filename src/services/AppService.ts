import { applicationRuntime } from '../runtime/ApplicationRuntime';
import { createLogger } from '../observability/Logger';
import type { PeerId } from '../network/NetworkTypes';
import type { WebRtcSessionSnapshot } from '../network/WebRtcPeerTransport';
import type { WebRtcAutoSignalingStatus } from '../network/WebRtcAutoSignaling';
import type { WebRtcPairingResult } from './peers/WebRtcConnectionWorkflow';
import type { StorageHealthSnapshot } from '../runtime/StorageHealth';
import type { MediaDownloadState, MediaDownloadStateHandler } from './media/PeerMediaSyncService';
import type { MediaCacheCleanupResult } from './media/MediaCacheCleanupService';
import type {
  ApplicationEventHandler,
  ApplicationEventTopic,
  ApplicationConnectivitySnapshot,
} from './events/ApplicationEventService';

/**
 * AppService manages the complete application lifecycle
 * Now delegates to ApplicationRuntime for proper initialization
 */
export class AppService {
  private static instance: AppService;
  private readonly logger = createLogger('AppService');

  private constructor() {}

  static getInstance(): AppService {
    if (!AppService.instance) {
      AppService.instance = new AppService();
    }
    return AppService.instance;
  }

  async initialize(): Promise<void> {
    this.logger.info('initialize_delegated_to_runtime');
    await applicationRuntime.initialize();
  }

  getDatabase() {
    return applicationRuntime.getDatabaseService();
  }

  getNetworkService() {
    return applicationRuntime.getNetworkService();
  }

  getRuntimeHealth() {
    return applicationRuntime.getHealthSnapshot();
  }

  async getDetailedRuntimeHealth() {
    return await applicationRuntime.getDetailedHealthSnapshot();
  }

  async getStorageHealth(): Promise<StorageHealthSnapshot> {
    return await applicationRuntime.getStorageHealthSnapshot();
  }

  getWalletService() {
    return applicationRuntime.getWalletService();
  }

  getPostRepository() {
    return applicationRuntime.getPostRepository();
  }

  getProfileRepository() {
    return applicationRuntime.getProfileRepository();
  }

  getCommentRepository() {
    return applicationRuntime.getCommentRepository();
  }

  getReactionRepository() {
    return applicationRuntime.getReactionRepository();
  }

  getFollowRepository() {
    return applicationRuntime.getFollowRepository();
  }

  getChatMessageRepository() {
    return applicationRuntime.getChatMessageRepository();
  }

  getSocialApplicationService() {
    return applicationRuntime.getSocialApplicationService();
  }

  getSocialQueryService() {
    return applicationRuntime.getSocialQueryService();
  }

  subscribeApplicationEvents(
    topics: ApplicationEventTopic | readonly ApplicationEventTopic[],
    handler: ApplicationEventHandler,
  ): () => void {
    return applicationRuntime.getApplicationEventService().subscribe(topics, handler);
  }

  getConnectivitySnapshot(): ApplicationConnectivitySnapshot {
    return applicationRuntime.getApplicationEventService().getConnectivitySnapshot();
  }

  getMediaObjectRepository() {
    return applicationRuntime.getMediaObjectRepository();
  }

  getMediaChunkRepository() {
    return applicationRuntime.getMediaChunkRepository();
  }

  getCryptoService() {
    return applicationRuntime.getCryptoService();
  }

  getReputationService() {
    return applicationRuntime.getReputationService();
  }

  getStorageService() {
    return applicationRuntime.getStorageService();
  }

  getMediaUploadService() {
    return applicationRuntime.getMediaUploadService();
  }

  getMediaDownloadState(mediaObjectId: string): MediaDownloadState | null {
    try {
      return applicationRuntime.getPeerMediaSyncService().getDownloadState(mediaObjectId);
    } catch {
      return null;
    }
  }

  async retryMediaDownload(mediaObjectId: string): Promise<void> {
    await applicationRuntime.getPeerMediaSyncService().retryMediaObject(mediaObjectId);
  }

  async enqueueMediaDownload(
    mediaObjectId: string,
    priority = 0,
  ): Promise<MediaDownloadState | null> {
    try {
      return await applicationRuntime.getPeerMediaSyncService().enqueueMediaObject(mediaObjectId, {
        priority,
      });
    } catch {
      return null;
    }
  }

  async cancelMediaDownload(mediaObjectId: string): Promise<MediaDownloadState | null> {
    try {
      return await applicationRuntime.getPeerMediaSyncService().cancelMediaDownload(mediaObjectId);
    } catch {
      return null;
    }
  }

  subscribeMediaDownloads(handler: MediaDownloadStateHandler): () => void {
    try {
      return applicationRuntime.getPeerMediaSyncService().subscribeDownloadStates(handler);
    } catch {
      return () => {};
    }
  }

  async cleanupMediaCache(options: { maxBytes?: number } = {}): Promise<MediaCacheCleanupResult> {
    return await applicationRuntime.cleanupMediaCache(options);
  }

  async markMediaAccess(mediaObjectId: string): Promise<void> {
    await applicationRuntime.markMediaAccess(mediaObjectId);
  }

  getMediaRepairSnapshot() {
    return applicationRuntime.getMediaRepairSnapshot();
  }

  subscribeMediaRuntime(handler: () => void): () => void {
    return applicationRuntime.subscribeMediaRuntime(handler);
  }

  async clearPeerData() {
    await this.initialize();
    return await applicationRuntime.clearPeerData();
  }

  async clearLocalData() {
    await this.initialize();
    return await applicationRuntime.clearLocalData();
  }

  getConsensusEngine() {
    return applicationRuntime.getConsensusEngine();
  }

  getContributionEngine() {
    return applicationRuntime.getContributionEngine();
  }

  getTrustEngine() {
    return applicationRuntime.getTrustEngine();
  }

  getContributionNetworkIntegration() {
    return applicationRuntime.getContributionNetworkIntegration();
  }

  getTrustedPeerRepository() {
    return applicationRuntime.getTrustedPeerRepository();
  }

  getPeerInviteService() {
    return applicationRuntime.getPeerInviteService();
  }

  getWebRtcConnectionWorkflow() {
    return applicationRuntime.getWebRtcConnectionWorkflow();
  }

  getPeerTrustService() {
    return applicationRuntime.getPeerTrustService();
  }

  getTrustedPeerSyncService() {
    return applicationRuntime.getTrustedPeerSyncService();
  }

  getLocalPeerId() {
    return applicationRuntime.getLocalPeerId();
  }

  async createLocalIdentity() {
    return await applicationRuntime.createLocalIdentity();
  }

  async exportIdentityBackup(): Promise<string> {
    await this.initialize();
    return applicationRuntime.exportIdentityBackup();
  }

  async importIdentityBackup(serializedBackup: string): Promise<PeerId> {
    await this.initialize();
    return await applicationRuntime.importIdentityBackup(serializedBackup);
  }

  private async ensureLocalPeerIdentity(): Promise<PeerId> {
    await this.initialize();
    const existing = applicationRuntime.getLocalPeerId();
    if (existing) {
      return existing;
    }
    return await applicationRuntime.createLocalIdentity();
  }

  async createPeerOffer(peerId?: PeerId): Promise<string> {
    await this.initialize();
    const result = await applicationRuntime
      .getWebRtcConnectionWorkflow()
      .createOfferForPeer(peerId);
    return result.code ?? '';
  }

  async connectPeer(peerId: PeerId): Promise<WebRtcPairingResult> {
    await this.initialize();
    return await applicationRuntime.getWebRtcConnectionWorkflow().connectPeer(peerId);
  }

  async acceptPeerOffer(offerCode: string): Promise<string> {
    await this.initialize();
    const result = await applicationRuntime.getWebRtcConnectionWorkflow().acceptOffer(offerCode);
    return result.code ?? '';
  }

  async applyPeerAnswer(answerCode: string): Promise<void> {
    await this.initialize();
    await applicationRuntime.getWebRtcConnectionWorkflow().applyAnswer(answerCode);
  }

  hasPendingPeerOffer(sessionId?: string): boolean {
    return applicationRuntime.getWebRtcConnectionWorkflow().hasPendingOffer(sessionId);
  }

  getWebRtcSessions(): WebRtcSessionSnapshot[] {
    return applicationRuntime.getWebRtcConnectionWorkflow().getSessions();
  }

  getWebRtcSignalingStatus(): WebRtcAutoSignalingStatus | null {
    return applicationRuntime.getNetworkService().getAutoSignalingStatus();
  }

  async createPrivateNetwork(name?: string, signalingUrl?: string): Promise<string> {
    await this.ensureLocalPeerIdentity();
    return await applicationRuntime.getNetworkService().createPrivateNetwork(name, signalingUrl);
  }

  async joinPrivateNetwork(inviteCode: string) {
    await this.ensureLocalPeerIdentity();
    return await applicationRuntime.getNetworkService().joinPrivateNetwork(inviteCode);
  }

  async approvePrivateNetworkPeer(peerId: PeerId): Promise<void> {
    await this.ensureLocalPeerIdentity();
    await applicationRuntime.getNetworkService().approvePrivateNetworkPeer(peerId);
  }

  getPrivateNetworkSnapshot() {
    return applicationRuntime.getNetworkService().getPrivateNetworkSnapshot();
  }

  setSignalingServerUrl(url: string | null): void {
    applicationRuntime.getNetworkService().setSignalingServerUrl(url);
  }

  retryWebRtcSignaling(): void {
    applicationRuntime.getNetworkService().restartAutoSignaling();
  }

  isInitialized(): boolean {
    return applicationRuntime.isReady();
  }

  async shutdown(): Promise<void> {
    await applicationRuntime.shutdown();
  }
}

export const appService = AppService.getInstance();
