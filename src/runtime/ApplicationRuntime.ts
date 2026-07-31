import type { DatabaseService } from '../database/DatabaseService';
import { openDatabaseService } from '../database/sqliteAdapter';
import { NetworkService } from '../services/network/NetworkService';
import { WalletService } from '../economy/Wallet/WalletService';
import { CanonicalTransactionRepository } from '../economy/Wallet/CanonicalTransactionRepository';
import { ConsensusRepository } from '../consensus/ConsensusRepository';
import { PostRepository } from '../repositories/PostRepository';
import { ProfileRepository } from '../repositories/ProfileRepository';
import { ChatMessageRepository } from '../repositories/ChatMessageRepository';
import { CommentRepository } from '../repositories/CommentRepository';
import { FollowRepository } from '../repositories/FollowRepository';
import { MediaObjectRepository } from '../repositories/MediaObjectRepository';
import { MediaChunkRepository } from '../repositories/MediaChunkRepository';
import { ReactionRepository } from '../repositories/ReactionRepository';
import { CryptoService } from '../crypto/CryptoService';
import { localStorageService } from '../services/storage/mmkvStorage';
import { IncrementalSyncService } from '../services/sync/IncrementalSyncService';
import { SyncCheckpointRepository } from '../services/sync/SyncCheckpointRepository';
import { ReputationService } from '../services/reputation/ReputationService';
import { DistributedStorageService } from '../storage/distributed/DistributedStorageService';
import { MediaService } from '../services/media/MediaService';
import { PeerMediaSyncService } from '../services/media/PeerMediaSyncService';
import { MediaDownloadRepository } from '../services/media/MediaDownloadRepository';
import { MediaIntegrityService } from '../services/media/MediaIntegrityService';
import { MediaAvailabilityService } from '../services/media/MediaAvailabilityService';
import { MediaSourceSelector } from '../services/media/MediaSourceSelector';
import { MediaRepairService } from '../services/media/MediaRepairService';
import {
  MediaCacheCleanupService,
  type MediaCacheCleanupResult,
} from '../services/media/MediaCacheCleanupService';
import { ConsensusEngine } from '../consensus/ConsensusEngine';
import { RewardCalculator } from '../economy/RewardCalculator';
import { RewardPool } from '../economy/RewardPool';
import { RewardSchedule } from '../economy/RewardSchedule';
import { InflationController } from '../economy/InflationController';
import { AntiAbuseController } from '../economy/AntiAbuseController';
import { eventBus } from '../events/EventBus';
import type { PeerId } from '../network/NetworkTypes';
import { ContributionEngine } from '../contribution/ContributionEngine';
import { TrustEngine } from '../contribution/TrustEngine';
import { ContributionNetworkIntegration } from '../services/contribution/ContributionNetworkIntegration';
import { TrustedPeerRepository } from '../services/peers/TrustedPeerRepository';
import { PeerInviteService } from '../services/peers/PeerInviteService';
import { PeerTrustService } from '../services/peers/PeerTrustService';
import { TrustedPeerSyncService } from '../services/peers/TrustedPeerSyncService';
import { PeerReconnectService } from '../services/peers/PeerReconnectService';
import { WebRtcConnectionWorkflow } from '../services/peers/WebRtcConnectionWorkflow';
import { createLogger } from '../observability/Logger';
import { createRuntimeHealthSnapshot, type RuntimeHealthSnapshot } from './RuntimeHealth';
import { createStorageHealthSnapshot, type StorageHealthSnapshot } from './StorageHealth';
import { DefaultRuntimeHealthService, type ComponentHealth } from './RuntimeHealthService';
import { assertRuntimeStatus, type RuntimeLifecycle, type RuntimeStatus } from './RuntimeLifecycle';
import { shouldAttemptPeerReconnect } from './RuntimeWatchdogPolicy';
import type { PeerTransport } from '../network/PeerTransport';
import { SocialApplicationService } from '../services/social/SocialApplicationService';
import { SocialQueryService } from '../services/social/SocialQueryService';
import { SocialReplicationService } from '../services/social/SocialReplicationService';
import { SocialReplicationQueueRepository } from '../services/social/SocialReplicationQueueRepository';
import { SocialConflictDecisionRepository } from '../services/social/SocialConflictDecisionRepository';
import { ApplicationEventService } from '../services/events/ApplicationEventService';
import type { SynpeerPrivateNetworkSnapshot } from '../network/WebRtcAutoSignaling';

/**
 * Runtime state
 */
export type RuntimeState = 'idle' | 'initializing' | 'ready' | 'error';

/**
 * Runtime configuration
 */
export interface RuntimeConfig {
  autoStartNetwork?: boolean;
  autoStartSync?: boolean;
  enableConsensus?: boolean;
  enableMedia?: boolean;
  enableLegacyProtocols?: boolean;
}

export interface ClearPeerDataResult {
  trustedPeers: number;
  syncCheckpoints: number;
  replicationQueueItems: number;
  mediaDownloadStates: number;
  mediaAvailabilityManifests: number;
  distributedStorageKeys: number;
}

export interface ClearLocalDataResult extends ClearPeerDataResult {
  identityCleared: boolean;
  walletCleared: boolean;
  databaseReset: boolean;
  mediaCacheCleared: boolean;
}

/**
 * ApplicationRuntime manages the complete application lifecycle
 * Initializes all services in the correct order and manages their lifecycle
 */
export class ApplicationRuntime implements RuntimeLifecycle {
  private static instance: ApplicationRuntime;
  private readonly logger = createLogger('ApplicationRuntime');
  private state: RuntimeState = 'idle';
  private status: RuntimeStatus = 'idle';
  private config: RuntimeConfig;
  private initializationPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly healthService = new DefaultRuntimeHealthService(() =>
    this.collectHealthSnapshot(),
  );

  // Database
  private databaseService: DatabaseService | null = null;

  // Crypto & Identity
  private cryptoService: CryptoService | null = null;
  private localPeerId: PeerId | null = null;

  // Network
  private networkService: NetworkService | null = null;

  // Economy
  private walletService: WalletService | null = null;

  // Repositories
  private postRepository: PostRepository | null = null;
  private profileRepository: ProfileRepository | null = null;
  private commentRepository: CommentRepository | null = null;
  private reactionRepository: ReactionRepository | null = null;
  private followRepository: FollowRepository | null = null;
  private chatMessageRepository: ChatMessageRepository | null = null;
  private mediaObjectRepository: MediaObjectRepository | null = null;
  private mediaChunkRepository: MediaChunkRepository | null = null;

  // Services
  private incrementalSyncService: IncrementalSyncService | null = null;
  private syncCheckpointRepository: SyncCheckpointRepository | null = null;
  private reputationService: ReputationService | null = null;
  private storageService: DistributedStorageService | null = null;
  private mediaUploadService: MediaService | null = null;
  private peerMediaSyncService: PeerMediaSyncService | null = null;
  private mediaDownloadRepository: MediaDownloadRepository | null = null;
  private mediaAvailabilityService: MediaAvailabilityService | null = null;
  private mediaRepairService: MediaRepairService | null = null;
  private unsubscribeMediaAvailability: (() => void) | null = null;
  private mediaCacheCleanupService: MediaCacheCleanupService | null = null;
  private readonly mediaIntegrityService = new MediaIntegrityService();
  private contributionEngine: ContributionEngine | null = null;
  private trustEngine: TrustEngine | null = null;
  private contributionNetworkIntegration: ContributionNetworkIntegration | null = null;
  private trustedPeerRepository: TrustedPeerRepository | null = null;
  private peerInviteService: PeerInviteService | null = null;
  private peerTrustService: PeerTrustService | null = null;
  private trustedPeerSyncService: TrustedPeerSyncService | null = null;
  private peerReconnectService: PeerReconnectService | null = null;
  private webRtcConnectionWorkflow: WebRtcConnectionWorkflow | null = null;
  private unsubscribePeerTrustEvents: (() => void) | null = null;
  private socialApplicationService: SocialApplicationService | null = null;
  private socialQueryService: SocialQueryService | null = null;
  private socialReplicationService: SocialReplicationService | null = null;
  private socialReplicationQueueRepository: SocialReplicationQueueRepository | null = null;
  private socialConflictDecisionRepository: SocialConflictDecisionRepository | null = null;
  private applicationEventService: ApplicationEventService | null = null;
  private boundSocialTransport: PeerTransport | null = null;
  private unsubscribeSocialReplication: (() => void) | null = null;

  // Consensus
  private consensusEngine: ConsensusEngine | null = null;

  // Economy
  private rewardCalculator: RewardCalculator | null = null;
  private rewardPool: RewardPool | null = null;
  private rewardSchedule: RewardSchedule | null = null;
  private inflationController: InflationController | null = null;
  private antiAbuseController: AntiAbuseController | null = null;

  // Failure Recovery
  private watchdogInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof globalThis.setInterval> | null = null;

  private constructor(config: RuntimeConfig = {}) {
    this.config = {
      autoStartNetwork: config.autoStartNetwork ?? true,
      autoStartSync: config.autoStartSync ?? true,
      enableConsensus: config.enableConsensus ?? true,
      enableMedia: config.enableMedia ?? true,
      enableLegacyProtocols: config.enableLegacyProtocols ?? false,
    };
  }

  static getInstance(config?: RuntimeConfig): ApplicationRuntime {
    const scope = globalThis as typeof globalThis & {
      __synpeerApplicationRuntime?: ApplicationRuntime;
    };
    if (scope.__synpeerApplicationRuntime) {
      ApplicationRuntime.instance = scope.__synpeerApplicationRuntime;
      return scope.__synpeerApplicationRuntime;
    }
    if (!ApplicationRuntime.instance) {
      ApplicationRuntime.instance = new ApplicationRuntime(config);
    }
    scope.__synpeerApplicationRuntime = ApplicationRuntime.instance;
    return ApplicationRuntime.instance;
  }

  static create(config?: RuntimeConfig): ApplicationRuntime {
    return new ApplicationRuntime(config);
  }

  /**
   * Get current runtime state
   */
  getState(): RuntimeState {
    return this.state;
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  async start(): Promise<void> {
    await this.initialize();
  }

  async stop(): Promise<void> {
    await this.shutdown();
  }

  getHealthSnapshot(): RuntimeHealthSnapshot {
    return this.collectHealthSnapshot();
  }

  async getDetailedHealthSnapshot(): Promise<RuntimeHealthSnapshot> {
    const snapshot = this.collectHealthSnapshot();
    const storageHealth = await this.getStorageHealthSnapshot();

    return {
      ...snapshot,
      storage: {
        ...snapshot.storage,
        usedBytes: storageHealth.totalUsedBytes,
        totalKeys: storageHealth.totalKeys,
        details: storageHealth,
      },
    };
  }

  async getStorageHealthSnapshot(): Promise<StorageHealthSnapshot> {
    const [mediaObjects, chunks, posts] =
      this.mediaObjectRepository && this.mediaChunkRepository && this.postRepository
        ? await Promise.all([
            this.mediaObjectRepository.getAll(1000, 0),
            this.mediaChunkRepository.getAll(),
            this.postRepository.getAll(1000, 0),
          ])
        : [[], [], []];
    const storageKeys = this.storageService?.getAllKeys() ?? [];
    const distributedStorage = this.storageService?.getStorageUsage();
    return createStorageHealthSnapshot({
      distributedStorageBytes: distributedStorage?.used ?? 0,
      totalKeys: storageKeys.length,
      replicatedKeys: this.storageService
        ? storageKeys.filter((key) => this.storageService?.hasEnoughReplicas(key)).length
        : 0,
      mediaObjects,
      chunks,
      posts,
      activeDownloads: mediaObjects.filter((mediaObject) => {
        const state = this.peerMediaSyncService?.getDownloadState(mediaObject.id);
        return state?.status === 'queued' || state?.status === 'downloading';
      }).length,
    });
  }

  async getComponentHealth(): Promise<ComponentHealth[]> {
    return await this.healthService.getComponents();
  }

  private collectHealthSnapshot(): RuntimeHealthSnapshot {
    const deliveryStatus = this.socialReplicationService?.getQueueStatus() ?? {
      pending: 0,
      sending: 0,
      acked: 0,
      failed: 0,
    };
    const trustedPeers = this.trustedPeerRepository?.list() ?? [];
    const storageUsage = this.storageService?.getStorageUsage();
    const connectedPeers = this.networkService?.getConnectedPeers() ?? [];
    const discoveredPeers = this.networkService?.getDiscoveredPeers() ?? [];
    const latencyValues = connectedPeers
      .map((peerId) => this.networkService?.getPingProtocol().getAverageLatency(peerId) ?? null)
      .filter((latency): latency is number => latency !== null);
    const averageLatencyMs =
      latencyValues.length > 0
        ? Math.round(
            latencyValues.reduce((sum, latency) => sum + latency, 0) / latencyValues.length,
          )
        : null;
    const transportStats = this.getNetworkTransportStats();
    const mediaTransfer = this.peerMediaSyncService?.getTransferSchedulerSnapshot();
    const mediaRepair = this.mediaRepairService?.getSnapshot();
    const mediaDownloadStates =
      this.isReady() && this.mediaDownloadRepository
        ? this.mediaDownloadRepository.listStates()
        : [];
    const freshReplicaPeers = new Set(
      (this.isReady() && this.mediaDownloadRepository
        ? this.mediaDownloadRepository.listAnnouncements()
        : []
      )
        .filter((announcement) => announcement.expiresAt > Date.now())
        .map((announcement) => announcement.peerId),
    );

    return createRuntimeHealthSnapshot({
      state: this.state,
      initialized: this.isReady(),
      localPeerId: this.localPeerId,
      connectedPeers,
      discoveredPeers,
      networkRunning: this.networkService?.isRunning() ?? false,
      canDialManualPeer: this.networkService?.canConnectToPeerAddress() ?? false,
      averageLatencyMs,
      sync: {
        pending: deliveryStatus.pending,
        sending: deliveryStatus.sending,
        confirmed: deliveryStatus.acked,
        failed: deliveryStatus.failed,
        lastSyncTimestamp: getLastTrustedPeerSyncTimestamp(trustedPeers),
      },
      storage: {
        usedBytes: storageUsage?.used ?? null,
        totalKeys: this.storageService?.getAllKeys().length ?? null,
      },
      trustedPeers,
      transports: {
        messagesSent: transportStats?.messagesSent ?? 0,
        messagesReceived: transportStats?.messagesReceived ?? 0,
        pendingMessages: mediaTransfer?.queuedFrames ?? 0,
      },
      media: {
        downloadJobs: mediaDownloadStates.length,
        activeDownloads: mediaDownloadStates.filter(
          (state) => state.status === 'queued' || state.status === 'downloading',
        ).length,
        freshReplicaPeers: freshReplicaPeers.size,
        quarantinedReplicas:
          this.isReady() && this.mediaDownloadRepository
            ? this.mediaDownloadRepository.listQuarantines(Date.now()).length
            : 0,
        queuedFrames: mediaTransfer?.queuedFrames ?? 0,
        pendingBytes: (mediaTransfer?.queuedBytes ?? 0) + (mediaTransfer?.inFlightBytes ?? 0),
        blockedPeers: mediaTransfer?.blockedPeers ?? 0,
        pendingRepairs: mediaRepair?.pendingOffers ?? 0,
        underReplicatedObjects: mediaRepair?.underReplicatedObjects ?? 0,
        lastRepairAt: mediaRepair?.lastRepairAt ?? null,
      },
    });
  }

  private getNetworkTransportStats(): { messagesSent: number; messagesReceived: number } | null {
    const maybeNetwork = this.networkService as unknown as {
      getTransportStats?: () => { messagesSent: number; messagesReceived: number } | null;
    };
    return maybeNetwork?.getTransportStats?.() ?? null;
  }

  /**
   * Initialize the complete application runtime
   * Follows the initialization sequence defined in the protocol
   */
  async initialize(): Promise<void> {
    if (this.status === 'ready') {
      this.logger.info('already_initialized');
      return;
    }

    assertRuntimeStatus(this.status, ['idle', 'starting', 'stopped', 'failed'], 'start');

    if (this.initializationPromise) {
      this.logger.info('awaiting_initialization');
      await this.initializationPromise;
      return;
    }

    this.initializationPromise = this.performInitialization();
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async performInitialization(): Promise<void> {
    this.state = 'initializing';
    this.status = 'starting';
    this.logger.info('initialization_started');

    try {
      // Step 1: Initialize Database
      await this.initializeDatabase();
      this.logger.info('database_initialized');

      // Step 2: Initialize Crypto & Identity
      await this.initializeIdentity();
      this.logger.info('identity_initialized');

      // Step 3: Initialize Wallet
      await this.initializeWallet();
      this.logger.info('wallet_initialized');

      // Step 4: Initialize Network
      await this.initializeNetwork();
      this.logger.info('network_initialized');

      // Step 5: Initialize Services
      await this.initializeServices();
      this.logger.info('services_initialized');

      // Step 6: Initialize Consensus (if enabled)
      if (this.config.enableConsensus) {
        await this.initializeConsensus();
        this.logger.info('consensus_initialized');
      }

      // Step 7: Initialize Economy
      await this.initializeEconomy();
      this.logger.info('economy_initialized');

      this.logger.info('legacy_protocols_removed');

      // Step 8: Start Network (if enabled)
      if (this.config.autoStartNetwork) {
        await this.startNetwork();
        this.logger.info('network_started');
      }

      await this.startPeerTrust();
      this.logger.info('peer_trust_started');

      if (this.storageService) {
        await this.storageService.start();
        this.logger.info('storage_started');
      }

      // Step 10: Start Sync (if enabled)
      if (this.config.autoStartSync) {
        await this.startSync();
        this.logger.info('sync_started');
      }

      // Step 11: Initialize Event System
      this.initializeEventSystem();
      this.logger.info('event_system_initialized');

      // Step 12: Start Failure Recovery
      this.startFailureRecovery();
      this.logger.info('failure_recovery_started');

      this.state = 'ready';
      this.status = 'ready';
      this.logger.info('initialization_completed');
    } catch (error) {
      this.logger.error('initialization_failed', error);
      this.state = 'error';
      this.status = 'failed';
      throw error;
    }
  }

  /**
   * Initialize Database
   */
  private async initializeDatabase(): Promise<void> {
    try {
      this.databaseService = await openDatabaseService();
      this.logger.info('database_opened');
    } catch (error) {
      this.logger.error('database_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Initialize Crypto & Identity
   */
  private async initializeIdentity(): Promise<void> {
    try {
      this.cryptoService = new CryptoService(localStorageService);
      this.localPeerId = this.cryptoService.loadIdentity();
      if (this.localPeerId) {
        this.logger.info('identity_loaded', { peerId: this.localPeerId });
      } else {
        this.logger.info('identity_not_configured');
      }
    } catch (error) {
      this.logger.error('identity_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Initialize Wallet
   */
  private async initializeWallet(): Promise<void> {
    try {
      const transactionRepository = this.databaseService
        ? new CanonicalTransactionRepository(this.databaseService)
        : undefined;
      this.walletService = new WalletService(
        undefined,
        transactionRepository,
        this.cryptoService ?? undefined,
      );
      await this.walletService.initialize();

      // Create wallet if identity exists
      if (this.cryptoService) {
        const identity = this.localPeerId ?? this.cryptoService.loadIdentity();
        if (identity) {
          this.walletService.createWallet(identity as PeerId);
          this.logger.info('wallet_created_for_identity', { hasIdentity: true });
        }
      }
    } catch (error) {
      this.logger.error('wallet_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Initialize Network
   */
  private async initializeNetwork(): Promise<void> {
    try {
      this.networkService = new NetworkService({
        autoStart: false, // We'll start it manually
        networkConfig: undefined,
      });
      const maybeWebNetwork = this.networkService as unknown as {
        setLocalPeerId?: (peerId: PeerId | null) => void;
      };
      maybeWebNetwork.setLocalPeerId?.(this.localPeerId);
      this.logger.info('network_service_created');
    } catch (error) {
      this.logger.error('network_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Initialize Services
   */
  private async initializeServices(): Promise<void> {
    try {
      if (!this.databaseService) {
        throw new Error('Database service is required before initializing application services');
      }

      // Initialize Post Repository
      this.postRepository = new PostRepository(this.databaseService);
      this.profileRepository = new ProfileRepository(this.databaseService);
      this.commentRepository = new CommentRepository(this.databaseService);
      this.reactionRepository = new ReactionRepository(this.databaseService);
      this.followRepository = new FollowRepository(this.databaseService);
      this.chatMessageRepository = new ChatMessageRepository(this.databaseService);
      this.mediaObjectRepository = new MediaObjectRepository(this.databaseService);
      this.mediaChunkRepository = new MediaChunkRepository(this.databaseService);
      this.logger.info('repositories_created');

      // Initialize Reputation Service
      this.reputationService = new ReputationService({
        initialScore: 500,
        maxScore: 1000,
        minScore: 0,
        decayRate: 0.01,
        decayInterval: 86400000, // 1 day
      });
      this.logger.info('reputation_service_created');

      if (this.config.enableMedia && this.localPeerId) {
        this.storageService = new DistributedStorageService(
          {
            replicationFactor: 3,
            minReplicas: 2,
            maxStorage: 1024 * 1024 * 1024, // 1GB
            gcInterval: 3600000, // 1 hour
          },
          this.localPeerId,
        );
        this.logger.info('storage_service_created');
      }

      // Initialize the local media ingestion service. P2P transfer is composed
      // separately by ensurePeerMediaSyncService once a peer transport exists.
      if (this.config.enableMedia) {
        if (this.mediaObjectRepository && this.mediaChunkRepository) {
          this.mediaUploadService = new MediaService(
            this.mediaObjectRepository,
            this.mediaChunkRepository,
            undefined,
            this.mediaIntegrityService,
          );
        }
        this.logger.info('media_service_created');
      }

      this.contributionEngine = new ContributionEngine();
      this.trustEngine = new TrustEngine();
      this.contributionNetworkIntegration = new ContributionNetworkIntegration(
        this.contributionEngine,
        this.trustEngine,
        this.networkService ?? undefined,
      );
      this.trustedPeerRepository = new TrustedPeerRepository(localStorageService);
      this.socialReplicationQueueRepository = new SocialReplicationQueueRepository(
        this.databaseService,
      );
      this.socialConflictDecisionRepository = new SocialConflictDecisionRepository(
        this.databaseService,
      );
      this.syncCheckpointRepository = new SyncCheckpointRepository(this.databaseService);
      if (this.config.enableMedia) {
        this.mediaDownloadRepository = new MediaDownloadRepository(
          this.databaseService,
          localStorageService,
        );
        const mediaPersistenceMigration = await this.mediaDownloadRepository.initialize();
        this.logger.info('media_persistence_ready', {
          migratedDownloadJobs: mediaPersistenceMigration.migratedDownloadJobs,
          migratedAvailabilityAnnouncements:
            mediaPersistenceMigration.migratedAvailabilityAnnouncements,
          legacyDataRemoved: mediaPersistenceMigration.legacyDataRemoved,
        });
      }
      const deliveryMigration =
        await this.socialReplicationQueueRepository.migrateLegacyStorage(localStorageService);
      this.logger.info('social_delivery_repository_ready', deliveryMigration);
      this.configureSocialServices();
      await this.migrateLocalSocialProfile();
      const restoredChatProjections =
        await this.socialApplicationService?.restoreChatReceiptProjections();
      if (restoredChatProjections) {
        this.logger.info('chat_receipt_projections_restored', {
          restored: restoredChatProjections,
        });
      }
      await this.socialReplicationService?.start();
      this.configureIncrementalSyncService();
      this.peerInviteService = new PeerInviteService(
        this.trustedPeerRepository,
        () => this.getNetworkService(),
        () => this.getLocalPeerId(),
      );
      this.webRtcConnectionWorkflow = new WebRtcConnectionWorkflow(this.trustedPeerRepository, () =>
        this.getNetworkService(),
      );
      if (this.cryptoService) {
        this.peerTrustService = new PeerTrustService(
          this.trustedPeerRepository,
          this.cryptoService,
          () => this.getNetworkService(),
        );
      }
      this.trustedPeerSyncService = new TrustedPeerSyncService(
        this.trustedPeerRepository,
        async (peerId) => {
          const network = this.getNetworkService() as NetworkService & {
            syncPeer?: (targetPeerId: PeerId) => Promise<number>;
          };
          if (!network.syncPeer) {
            throw new Error('Remote incremental sync is not supported by this network adapter');
          }
          return await network.syncPeer(peerId);
        },
      );
      if (this.peerTrustService) {
        this.peerReconnectService = new PeerReconnectService(
          this.trustedPeerRepository,
          () => this.getNetworkService(),
          this.trustedPeerSyncService,
        );
      }
      this.logger.info('contribution_services_created');
    } catch (error) {
      this.logger.error('services_initialization_failed', error);
      throw error;
    }
  }

  private configureSocialServices(): void {
    if (!this.postRepository || !this.profileRepository) {
      return;
    }

    this.socialQueryService = new SocialQueryService(
      this.postRepository,
      this.profileRepository,
      this.commentRepository ?? undefined,
      this.reactionRepository ?? undefined,
      this.followRepository ?? undefined,
      this.chatMessageRepository ?? undefined,
    );
    if (!this.cryptoService || !this.localPeerId) {
      this.logger.info('social_application_waiting_for_identity');
      this.bindApplicationEvents();
      return;
    }

    this.socialReplicationService = new SocialReplicationService(
      this.localPeerId,
      () => this.getPeerTransport(),
      () => this.getSocialReplicationPeers(),
      this.socialReplicationQueueRepository ?? undefined,
    );
    this.socialApplicationService = new SocialApplicationService(
      this.postRepository,
      this.profileRepository,
      this.cryptoService,
      this.socialReplicationService,
      this.commentRepository ?? undefined,
      this.reactionRepository ?? undefined,
      this.followRepository ?? undefined,
      this.ensurePeerMediaSyncService(),
      this.chatMessageRepository ?? undefined,
      this.socialConflictDecisionRepository ?? undefined,
    );
    this.bindSocialPeerTransport();
    this.bindApplicationEvents();
    this.logger.info('social_services_created');
  }

  private async migrateLocalSocialProfile(): Promise<void> {
    try {
      const profile = await this.socialApplicationService?.migrateLocalProfileSignature();
      if (profile) {
        this.logger.info('local_profile_signature_migration_completed', {
          profileId: profile.id,
          version: profile.version,
          revision: profile.revision,
        });
      }
    } catch (error) {
      this.logger.warn('local_profile_signature_migration_failed', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private bindApplicationEvents(): void {
    if (!this.networkService) {
      return;
    }
    this.applicationEventService ??= new ApplicationEventService();
    const network = this.networkService as NetworkService & {
      subscribePrivateNetwork?: (
        handler: (snapshot: SynpeerPrivateNetworkSnapshot | null) => void | Promise<void>,
      ) => () => void;
    };
    this.applicationEventService.bind({
      socialEvents: this.socialApplicationService?.events,
      networkEvents: this.networkService.getNetworkEvents(),
      subscribePrivateNetwork: network.subscribePrivateNetwork
        ? (handler) => network.subscribePrivateNetwork?.(handler) ?? (() => undefined)
        : undefined,
    });
  }

  private configureIncrementalSyncService(): void {
    if (!this.postRepository || !this.trustedPeerRepository) {
      return;
    }
    this.incrementalSyncService = new IncrementalSyncService(
      this.getLocalPeerId() ?? 'local',
      this.postRepository,
      this.trustedPeerRepository,
      50,
      this.profileRepository ?? undefined,
      this.socialApplicationService ?? undefined,
      this.commentRepository ?? undefined,
      this.reactionRepository ?? undefined,
      this.followRepository ?? undefined,
      this.chatMessageRepository ?? undefined,
      this.socialApplicationService?.events,
      this.syncCheckpointRepository ?? undefined,
    );
  }

  private getPeerTransport(): PeerTransport | null {
    const maybeNetwork = this.networkService as unknown as {
      getPeerTransport?: () => PeerTransport | null;
    };
    return maybeNetwork?.getPeerTransport?.() ?? null;
  }

  private getSocialReplicationPeers(): PeerId[] {
    const connectedPeers = Array.from(
      new Set([
        ...((this.networkService?.getConnectedPeers() ?? []) as PeerId[]),
        ...(this.getPeerTransport()?.getConnectedPeers() ?? []),
      ]),
    );

    if (!this.trustedPeerRepository) {
      return [];
    }

    return connectedPeers.filter((peerId) => {
      const peer = this.trustedPeerRepository?.get(peerId);
      return peer?.trustStatus === 'verified' && peer.sessionState !== 'blocked';
    });
  }

  private bindSocialPeerTransport(): void {
    const transport = this.getPeerTransport();
    if (!transport || !this.socialApplicationService) {
      return;
    }

    if (this.boundSocialTransport === transport && this.unsubscribeSocialReplication) {
      return;
    }

    this.unsubscribeSocialReplication?.();
    this.unsubscribeSocialReplication = null;
    this.boundSocialTransport = transport;

    const unsubscribeSocialMessages = transport.subscribe(async (message, connection) => {
      try {
        if (await this.socialReplicationService?.handleAck(message, connection.peerId)) {
          return;
        }
        await this.socialApplicationService?.handleRemoteMessage(message, connection);
      } catch (error) {
        this.logger.warn('social_remote_message_rejected', {
          peerId: connection.peerId,
          messageType: message.messageType,
          error: error instanceof Error ? error.message : 'Unknown social message error',
        });
      }
    });
    const maybeWebRtcTransport = transport as PeerTransport & {
      onConnectionOpen?: (listener: (peerId: PeerId, sessionId: string) => void) => () => void;
    };
    const unsubscribeConnectionOpen = maybeWebRtcTransport.onConnectionOpen?.(
      (peerId, sessionId) => {
        this.logger.info('social_transport_connection_open', { peerId, sessionId });
        void this.socialReplicationService?.processPendingQueue().catch((error) => {
          this.logger.warn('social_replication_queue_process_failed', {
            peerId,
            error: error instanceof Error ? error.message : 'Unknown queue processing error',
          });
        });
      },
    );
    this.unsubscribeSocialReplication = () => {
      unsubscribeSocialMessages();
      unsubscribeConnectionOpen?.();
      this.boundSocialTransport = null;
    };
    this.logger.info('social_transport_bound');
  }

  private ensurePeerMediaSyncService(): PeerMediaSyncService | undefined {
    const transport = this.getPeerTransport();
    if (
      !this.config.enableMedia ||
      !this.localPeerId ||
      !this.cryptoService ||
      !transport ||
      !this.mediaObjectRepository ||
      !this.mediaChunkRepository
    ) {
      return undefined;
    }
    if (!this.peerMediaSyncService) {
      const mediaDownloadRepository = this.requireMediaDownloadRepository();
      this.mediaAvailabilityService = new MediaAvailabilityService(
        this.localPeerId,
        this.cryptoService,
        mediaDownloadRepository,
      );
      this.peerMediaSyncService = new PeerMediaSyncService(
        this.localPeerId,
        transport,
        this.mediaObjectRepository,
        this.mediaChunkRepository,
        undefined,
        {
          canAcceptReplicaOffer: (peerId) => {
            const peer = this.trustedPeerRepository?.get(peerId);
            return peer?.trustStatus === 'verified' && peer.sessionState !== 'blocked';
          },
          onLocalAvailabilityAnnounced: () => {
            const repairService = this.mediaRepairService;
            if (!repairService) {
              return;
            }
            if (!repairService.getSnapshot().running) {
              repairService.start();
            } else {
              repairService.scheduleRepair('local-availability');
            }
          },
        },
        mediaDownloadRepository,
        this.mediaIntegrityService,
        this.mediaAvailabilityService,
        new MediaSourceSelector(mediaDownloadRepository),
      );
      this.mediaRepairService = new MediaRepairService(
        this.localPeerId,
        this.mediaObjectRepository,
        this.mediaChunkRepository,
        mediaDownloadRepository,
        {
          getEligiblePeers: () => this.getSocialReplicationPeers(),
          offerReplica: async (peerId, mediaObjectId) => {
            const mediaSync = this.peerMediaSyncService;
            return mediaSync ? await mediaSync.offerReplica(peerId, mediaObjectId) : false;
          },
        },
        this.mediaIntegrityService,
      );
      this.unsubscribeMediaAvailability = this.mediaAvailabilityService.subscribeAccepted(
        (announcement) => {
          this.mediaRepairService?.handleAvailabilityAnnouncement(announcement);
        },
      );
      this.peerMediaSyncService.start();
      this.logger.info('peer_media_sync_started');
    }
    return this.peerMediaSyncService;
  }

  private requireMediaDownloadRepository(): MediaDownloadRepository {
    if (!this.mediaDownloadRepository) {
      throw new Error('Media download repository not initialized');
    }
    return this.mediaDownloadRepository;
  }

  /**
   * Initialize Consensus
   */
  private async initializeConsensus(): Promise<void> {
    try {
      const consensusRepository = this.databaseService
        ? new ConsensusRepository(this.databaseService)
        : undefined;
      this.consensusEngine = new ConsensusEngine(undefined, consensusRepository);
      await this.consensusEngine.initialize();
      this.logger.info('consensus_engine_created');
    } catch (error) {
      this.logger.error('consensus_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Initialize Economy
   */
  private async initializeEconomy(): Promise<void> {
    try {
      // Initialize Reward Calculator
      this.rewardCalculator = new RewardCalculator();
      this.logger.info('reward_calculator_created');

      // Initialize Reward Pool
      this.rewardPool = new RewardPool();
      this.logger.info('reward_pool_created');

      // Initialize Reward Schedule
      this.rewardSchedule = new RewardSchedule();
      this.logger.info('reward_schedule_created');

      // Initialize Inflation Controller
      this.inflationController = new InflationController({
        annualReduction: 0.1,
      });
      this.logger.info('inflation_controller_created');

      // Initialize Anti-Abuse Controller
      this.antiAbuseController = new AntiAbuseController();
      this.logger.info('anti_abuse_controller_created');
    } catch (error) {
      this.logger.error('economy_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Initialize Event System
   */
  private initializeEventSystem(): void {
    try {
      // EventBus is already a singleton, just verify it's available
      this.logger.info('event_system_ready');

      // Emit initialization event
      eventBus.emit('SyncCompleted', { syncedCount: 0 });
    } catch (error) {
      this.logger.error('event_system_initialization_failed', error);
      throw error;
    }
  }

  /**
   * Start Failure Recovery
   */
  private startFailureRecovery(): void {
    try {
      if (this.watchdogInterval || this.healthCheckInterval) {
        this.logger.debug('failure_recovery_already_started');
        return;
      }
      // Start watchdog for network monitoring
      this.watchdogInterval = globalThis.setInterval(() => {
        this.watchdogCheck();
      }, 30000); // Check every 30 seconds

      // Start health check for services
      this.healthCheckInterval = globalThis.setInterval(() => {
        this.healthCheck();
      }, 60000); // Check every minute

      this.logger.info('failure_recovery_mechanisms_started');
    } catch (error) {
      this.logger.error('failure_recovery_start_failed', error);
    }
  }

  /**
   * Watchdog check for network connectivity
   */
  private watchdogCheck(): void {
    if (!this.networkService) return;

    try {
      const connectedPeers = this.networkService.getConnectedPeers();
      if (connectedPeers.length > 0) {
        return;
      }

      if (connectedPeers.length === 0) {
        if (!this.hasReconnectCandidates()) {
          this.logger.debug('no_auto_reconnect_candidates');
          return;
        }

        void this.peerReconnectService?.reconnectTrustedPeers().catch((error) => {
          this.logger.warn('trusted_peer_reconnect_refresh_failed', {
            message: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
    } catch (error) {
      this.logger.error('watchdog_check_failed', error);
    }
  }

  /**
   * Health check for all services
   */
  private healthCheck(): void {
    try {
      this.logger.debug('health_check_started');

      // Check database
      if (!this.databaseService) {
        this.logger.warn('database_service_unavailable');
      }

      // Check network
      if (!this.networkService) {
        this.logger.warn('network_service_unavailable');
      }

      // Check wallet
      if (!this.walletService) {
        this.logger.warn('wallet_service_unavailable');
      }

      this.logger.debug('health_check_completed');
    } catch (error) {
      this.logger.error('health_check_failed', error);
    }
  }

  private hasReconnectCandidates(): boolean {
    const maybeWebNetwork = this.networkService as unknown as {
      canAutoConnectToPeer?: () => boolean;
    };
    return shouldAttemptPeerReconnect(
      this.trustedPeerRepository?.list() ?? [],
      Boolean(
        this.networkService?.canAutoReconnectToPeerAddress() ||
        maybeWebNetwork.canAutoConnectToPeer?.(),
      ),
    );
  }

  /**
   * Start Network
   */
  private async startNetwork(): Promise<void> {
    if (!this.networkService) {
      throw new Error('Network service not initialized');
    }

    try {
      await this.networkService.start();
      this.logger.info('network_service_started');
    } catch (error) {
      this.logger.error('network_start_failed', error);
      throw error;
    }
  }

  /**
   * Start Sync
   */
  private async startSync(): Promise<void> {
    if (!this.incrementalSyncService) {
      this.logger.warn('incremental_sync_not_configured');
      return;
    }

    this.logger.info('incremental_sync_ready');
  }

  private async startPeerTrust(): Promise<void> {
    if (
      !this.networkService ||
      !this.peerTrustService ||
      !this.trustedPeerRepository ||
      !this.trustedPeerSyncService
    ) {
      return;
    }

    this.peerTrustService.start();
    this.configureNetworkPeerProtocols();
    const peerListener = (event: import('../network/NetworkEvents').NetworkEvent) => {
      if (event.type !== 'peer:connected') {
        return;
      }

      this.processSocialReplicationQueue(event.peerId, 'peer-connected');
      void this.peerMediaSyncService?.announceLocalAvailability().catch((error) => {
        this.logger.error('media_availability_announce_failed', error, { peerId: event.peerId });
      });
      this.mediaRepairService?.scheduleRepair('peer-connected');
    };
    this.networkService.getNetworkEvents().addEventListener('peer', peerListener);
    this.unsubscribePeerTrustEvents = () => {
      this.networkService?.getNetworkEvents().removeEventListener('peer', peerListener);
    };

    await this.peerReconnectService?.reconnectTrustedPeers();
  }

  private configureNetworkPeerProtocols(): void {
    if (
      !this.networkService ||
      !this.peerTrustService ||
      !this.trustedPeerRepository ||
      !this.trustedPeerSyncService
    ) {
      return;
    }

    const maybeWebNetwork = this.networkService as unknown as {
      configurePeerProtocols?: (configuration: {
        peerTrustService: PeerTrustService;
        trustedPeerRepository: TrustedPeerRepository;
        trustedPeerSyncService: TrustedPeerSyncService;
        incrementalSyncService: IncrementalSyncService | null;
      }) => void;
    };
    maybeWebNetwork.configurePeerProtocols?.({
      peerTrustService: this.peerTrustService,
      trustedPeerRepository: this.trustedPeerRepository,
      trustedPeerSyncService: this.trustedPeerSyncService,
      incrementalSyncService: this.incrementalSyncService,
    });
  }

  private processSocialReplicationQueue(peerId: PeerId, reason: string): void {
    void this.socialReplicationService?.processPendingQueue().catch((error) => {
      this.logger.warn('social_replication_queue_process_failed', {
        peerId,
        reason,
        error: error instanceof Error ? error.message : 'Unknown queue processing error',
      });
    });
  }

  async clearPeerData(): Promise<ClearPeerDataResult> {
    this.logger.info('clear_peer_data_started');

    const trustedPeers = this.trustedPeerRepository?.list().length ?? 0;
    const syncCheckpoints = (await this.syncCheckpointRepository?.list())?.length ?? 0;
    const queueStatus = (await this.socialReplicationQueueRepository?.getStatus()) ?? {
      pending: 0,
      sending: 0,
      acked: 0,
      failed: 0,
    };
    const mediaDownloadRepository = this.mediaDownloadRepository;
    const mediaDownloadStates = mediaDownloadRepository?.listStates().length ?? 0;
    const mediaAvailabilityManifests = mediaDownloadRepository?.listManifests().length ?? 0;
    const distributedStorageKeys = this.storageService?.getAllKeys().length ?? 0;

    this.unsubscribeSocialReplication?.();
    this.unsubscribeSocialReplication = null;
    this.boundSocialTransport = null;
    this.socialReplicationService?.stop();
    this.unsubscribeMediaAvailability?.();
    this.unsubscribeMediaAvailability = null;
    this.mediaRepairService?.stop();
    this.mediaRepairService = null;
    this.mediaAvailabilityService = null;
    this.peerMediaSyncService?.stop();
    this.peerMediaSyncService = null;
    this.mediaCacheCleanupService = null;

    await this.networkService?.stop();
    this.peerTrustService?.stop();
    this.trustedPeerRepository?.clear();
    await this.syncCheckpointRepository?.clear();
    await this.socialReplicationQueueRepository?.clear();
    await this.socialConflictDecisionRepository?.clear();
    await mediaDownloadRepository?.clear();
    this.storageService?.clear();

    this.logger.info('clear_peer_data_completed', {
      trustedPeers,
      syncCheckpoints,
      replicationQueueItems:
        queueStatus.pending + queueStatus.sending + queueStatus.acked + queueStatus.failed,
      mediaDownloadStates,
      mediaAvailabilityManifests,
      distributedStorageKeys,
    });

    return {
      trustedPeers,
      syncCheckpoints,
      replicationQueueItems:
        queueStatus.pending + queueStatus.sending + queueStatus.acked + queueStatus.failed,
      mediaDownloadStates,
      mediaAvailabilityManifests,
      distributedStorageKeys,
    };
  }

  async clearLocalData(): Promise<ClearLocalDataResult> {
    this.logger.info('clear_local_data_started');
    const peerResult = await this.clearPeerData();

    this.cryptoService?.clearIdentity();
    this.walletService?.clearWallet();
    await this.databaseService?.reset();
    localStorageService.clear();

    this.localPeerId = null;
    this.socialApplicationService = null;
    this.socialQueryService = null;
    this.socialReplicationService = null;
    this.bindApplicationEvents();
    this.socialReplicationQueueRepository = this.databaseService
      ? new SocialReplicationQueueRepository(this.databaseService)
      : null;
    this.syncCheckpointRepository = this.databaseService
      ? new SyncCheckpointRepository(this.databaseService)
      : null;
    this.socialConflictDecisionRepository = this.databaseService
      ? new SocialConflictDecisionRepository(this.databaseService)
      : null;

    const maybeWebNetwork = this.networkService as unknown as {
      setLocalPeerId?: (peerId: PeerId | null) => void;
    };
    maybeWebNetwork?.setLocalPeerId?.(null);

    this.logger.info('clear_local_data_completed');

    return {
      ...peerResult,
      identityCleared: true,
      walletCleared: true,
      databaseReset: true,
      mediaCacheCleared: true,
    };
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'idle') {
      this.logger.info('shutdown_skipped', { status: this.status });
      this.status = 'stopped';
      return;
    }

    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    assertRuntimeStatus(this.status, ['ready', 'failed'], 'stop');
    this.status = 'stopping';
    this.shutdownPromise = this.performShutdown();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
    }
  }

  private async performShutdown(): Promise<void> {
    this.logger.info('shutdown_started');

    try {
      // Stop failure recovery
      if (this.watchdogInterval) {
        globalThis.clearInterval(this.watchdogInterval);
        this.watchdogInterval = null;
      }
      if (this.healthCheckInterval) {
        globalThis.clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      this.logger.info('failure_recovery_stopped');

      this.unsubscribePeerTrustEvents?.();
      this.unsubscribePeerTrustEvents = null;
      this.unsubscribeSocialReplication?.();
      this.unsubscribeSocialReplication = null;
      this.applicationEventService?.stop();
      this.socialReplicationService?.stop();
      this.unsubscribeMediaAvailability?.();
      this.unsubscribeMediaAvailability = null;
      this.mediaRepairService?.stop();
      this.mediaRepairService = null;
      this.mediaAvailabilityService = null;
      this.peerMediaSyncService?.stop();
      this.peerMediaSyncService = null;
      this.peerTrustService?.stop();
      this.logger.info('peer_trust_stopped');

      this.logger.info('sync_stopped');

      if (this.storageService) {
        this.storageService.stop();
        this.logger.info('storage_stopped');
      }

      // Stop network
      if (this.networkService) {
        await this.networkService.stop();
        this.logger.info('network_stopped');
      }

      if (this.databaseService) {
        await this.databaseService.close();
        this.logger.info('database_closed');
      }

      this.state = 'idle';
      this.status = 'stopped';
      this.logger.info('shutdown_completed');
    } catch (error) {
      this.logger.error('shutdown_failed', error);
      this.status = 'failed';
      throw error;
    }
  }

  // Getters for services

  getDatabaseService() {
    if (!this.databaseService) {
      throw new Error('Database service not initialized');
    }
    return this.databaseService;
  }

  getCryptoService() {
    if (!this.cryptoService) {
      throw new Error('Crypto service not initialized');
    }
    return this.cryptoService;
  }

  getNetworkService() {
    if (!this.networkService) {
      throw new Error('Network service not initialized');
    }
    return this.networkService;
  }

  getWalletService() {
    if (!this.walletService) {
      throw new Error('Wallet service not initialized');
    }
    return this.walletService;
  }

  getPostRepository() {
    if (!this.postRepository) {
      throw new Error('Post repository not initialized');
    }
    return this.postRepository;
  }

  getProfileRepository() {
    if (!this.profileRepository) {
      throw new Error('Profile repository not initialized');
    }
    return this.profileRepository;
  }

  getCommentRepository() {
    if (!this.commentRepository) {
      throw new Error('Comment repository not initialized');
    }
    return this.commentRepository;
  }

  getReactionRepository() {
    if (!this.reactionRepository) {
      throw new Error('Reaction repository not initialized');
    }
    return this.reactionRepository;
  }

  getFollowRepository() {
    if (!this.followRepository) {
      throw new Error('Follow repository not initialized');
    }
    return this.followRepository;
  }

  getChatMessageRepository() {
    if (!this.chatMessageRepository) {
      throw new Error('Chat message repository not initialized');
    }
    return this.chatMessageRepository;
  }

  getSocialApplicationService() {
    if (!this.socialApplicationService) {
      this.configureSocialServices();
    }
    if (!this.socialApplicationService) {
      throw new Error('Social application service not initialized');
    }
    return this.socialApplicationService;
  }

  getSocialQueryService() {
    if (!this.socialQueryService) {
      throw new Error('Social query service not initialized');
    }
    return this.socialQueryService;
  }

  getApplicationEventService(): ApplicationEventService {
    if (!this.applicationEventService) {
      this.bindApplicationEvents();
    }
    if (!this.applicationEventService) {
      throw new Error('Application event service not initialized');
    }
    return this.applicationEventService;
  }

  getMediaObjectRepository() {
    if (!this.mediaObjectRepository) {
      throw new Error('Media object repository not initialized');
    }
    return this.mediaObjectRepository;
  }

  getMediaChunkRepository() {
    if (!this.mediaChunkRepository) {
      throw new Error('Media chunk repository not initialized');
    }
    return this.mediaChunkRepository;
  }

  getReputationService() {
    if (!this.reputationService) {
      throw new Error('Reputation service not initialized');
    }
    return this.reputationService;
  }

  getStorageService() {
    if (!this.storageService) {
      throw new Error('Storage service not initialized');
    }
    return this.storageService;
  }

  getMediaUploadService() {
    if (!this.mediaUploadService) {
      throw new Error('Media upload service not initialized');
    }
    return this.mediaUploadService;
  }

  getPeerMediaSyncService() {
    const service = this.ensurePeerMediaSyncService();
    if (!service) {
      throw new Error('Peer media sync service not initialized');
    }
    return service;
  }

  async cleanupMediaCache(options: { maxBytes?: number } = {}): Promise<MediaCacheCleanupResult> {
    return await this.getMediaCacheCleanupService(options).cleanup();
  }

  private getMediaCacheCleanupService(
    options: { maxBytes?: number } = {},
  ): MediaCacheCleanupService {
    if (!this.mediaCacheCleanupService || options.maxBytes !== undefined) {
      if (!this.postRepository || !this.mediaObjectRepository || !this.mediaChunkRepository) {
        throw new Error('Media cache cleanup service not initialized');
      }
      this.mediaCacheCleanupService = new MediaCacheCleanupService(
        this.postRepository,
        this.mediaObjectRepository,
        this.mediaChunkRepository,
        {
          ...options,
          localPeerId: this.localPeerId ?? undefined,
          downloadRepository: this.mediaDownloadRepository ?? undefined,
        },
      );
    }
    return this.mediaCacheCleanupService;
  }

  async markMediaAccess(mediaObjectId: string): Promise<void> {
    await this.requireMediaDownloadRepository().touchMediaAccess(mediaObjectId);
  }

  getMediaRepairSnapshot() {
    return this.mediaRepairService?.getSnapshot() ?? null;
  }

  subscribeMediaRuntime(handler: () => void): () => void {
    const unsubscribes: Array<() => void> = [];
    if (this.peerMediaSyncService) {
      unsubscribes.push(this.peerMediaSyncService.subscribeDownloadStates(() => handler()));
    }
    if (this.mediaRepairService) {
      unsubscribes.push(this.mediaRepairService.subscribe(() => handler()));
    }
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }

  getConsensusEngine() {
    if (!this.consensusEngine) {
      throw new Error('Consensus engine not initialized');
    }
    return this.consensusEngine;
  }

  getContributionEngine() {
    if (!this.contributionEngine) {
      this.logger.warn('contribution_engine_lazy_initialized');
      this.contributionEngine = new ContributionEngine();
    }
    return this.contributionEngine;
  }

  getTrustEngine() {
    if (!this.trustEngine) {
      this.logger.warn('trust_engine_lazy_initialized');
      this.trustEngine = new TrustEngine();
    }
    return this.trustEngine;
  }

  getContributionNetworkIntegration() {
    if (!this.contributionNetworkIntegration) {
      this.logger.warn('contribution_network_integration_lazy_initialized');
      this.contributionNetworkIntegration = new ContributionNetworkIntegration(
        this.getContributionEngine(),
        this.getTrustEngine(),
        this.networkService ?? undefined,
      );
    }
    return this.contributionNetworkIntegration;
  }

  getTrustedPeerRepository() {
    if (!this.trustedPeerRepository) {
      throw new Error('Trusted peer repository not initialized');
    }
    return this.trustedPeerRepository;
  }

  getPeerInviteService() {
    if (!this.peerInviteService) {
      throw new Error('Peer invite service not initialized');
    }
    return this.peerInviteService;
  }

  getWebRtcConnectionWorkflow() {
    if (!this.webRtcConnectionWorkflow) {
      throw new Error('WebRTC connection workflow not initialized');
    }
    return this.webRtcConnectionWorkflow;
  }

  getPeerTrustService() {
    if (!this.peerTrustService) {
      throw new Error('Peer trust service not initialized');
    }
    return this.peerTrustService;
  }

  getTrustedPeerSyncService() {
    if (!this.trustedPeerSyncService) {
      throw new Error('Trusted peer sync service not initialized');
    }
    return this.trustedPeerSyncService;
  }

  getLocalPeerId(): PeerId | null {
    return this.localPeerId;
  }

  async createLocalIdentity(): Promise<PeerId> {
    if (!this.cryptoService) {
      throw new Error('Crypto service not initialized');
    }

    const existing = this.cryptoService.loadIdentity();
    const identity = (existing ?? (await this.cryptoService.createIdentity())) as PeerId;
    this.localPeerId = identity;
    const maybeWebNetwork = this.networkService as unknown as {
      setLocalPeerId?: (peerId: PeerId | null) => void;
    };
    maybeWebNetwork.setLocalPeerId?.(identity);

    if (this.walletService && !this.walletService.getWallet()) {
      this.walletService.createWallet(identity);
    }

    if (this.config.enableMedia && !this.storageService) {
      this.storageService = new DistributedStorageService(
        {
          replicationFactor: 3,
          minReplicas: 2,
          maxStorage: 1024 * 1024 * 1024,
          gcInterval: 3600000,
        },
        identity,
      );
      if (this.state === 'ready') {
        await this.storageService.start();
      }
    }

    this.configureSocialServices();
    await this.migrateLocalSocialProfile();
    await this.socialReplicationService?.start();
    this.configureIncrementalSyncService();
    this.configureNetworkPeerProtocols();

    return identity;
  }

  exportIdentityBackup(): string {
    if (!this.cryptoService) {
      throw new Error('Crypto service not initialized');
    }
    return this.cryptoService.exportIdentityBackup();
  }

  async importIdentityBackup(serializedBackup: string): Promise<PeerId> {
    if (!this.cryptoService) {
      throw new Error('Crypto service not initialized');
    }

    const identity = (await this.cryptoService.importIdentityBackup(serializedBackup)) as PeerId;
    this.localPeerId = identity;

    const maybeWebNetwork = this.networkService as unknown as {
      setLocalPeerId?: (peerId: PeerId | null) => void;
    };
    maybeWebNetwork.setLocalPeerId?.(identity);

    if (this.walletService) {
      this.walletService.createWallet(identity);
    }

    if (this.config.enableMedia) {
      this.storageService?.stop();
      this.storageService = new DistributedStorageService(
        {
          replicationFactor: 3,
          minReplicas: 2,
          maxStorage: 1024 * 1024 * 1024,
          gcInterval: 3600000,
        },
        identity,
      );
      if (this.state === 'ready') {
        await this.storageService.start();
      }
    }

    this.socialReplicationService?.stop();
    this.configureSocialServices();
    await this.migrateLocalSocialProfile();
    await this.socialReplicationService?.start();
    this.configureIncrementalSyncService();
    this.configureNetworkPeerProtocols();
    this.logger.info('identity_backup_imported', { peerId: identity });

    return identity;
  }

  isReady(): boolean {
    return this.state === 'ready';
  }
}

export const applicationRuntime = ApplicationRuntime.getInstance();

function getLastTrustedPeerSyncTimestamp(peers: Array<{ lastSyncAt?: number }>): number {
  return peers.reduce((latest, peer) => Math.max(latest, peer.lastSyncAt ?? 0), 0);
}
