import type { PeerId } from '@/network/NetworkTypes';
import type { NetworkService } from '@/services/network/NetworkService';
import { canonicalize } from '@/economy/Wallet/TransactionModel';
import { sha256Hex } from '@/utils/hash';
import { LEGACY_URI_SCHEME, URI_SCHEME } from '@/constants/Brand';

import type { TrustedPeerRepository } from './TrustedPeerRepository';
import type { PeerInvite } from './TrustedPeerTypes';

const INVITE_SCHEME = `${URI_SCHEME}:peer`;
const LEGACY_INVITE_SCHEME = `${LEGACY_URI_SCHEME}:peer`;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export class PeerInviteService {
  constructor(
    private readonly repository: TrustedPeerRepository,
    private readonly getNetworkService: () => NetworkService,
    private readonly getLocalPeerId: () => PeerId | null,
  ) {}

  async createInvite(): Promise<string> {
    const networkService = this.getNetworkService();
    const localIdentity = await networkService.getLocalIdentity();
    const peerId =
      networkService.getPeerManager().getPeerId() ?? localIdentity?.peerId ?? this.getLocalPeerId();
    if (!peerId) {
      throw new Error('Local peer identity is not available');
    }

    const createdAt = Date.now();
    const invite: PeerInvite = {
      version: 1,
      peerId,
      identityId: localIdentity?.publicIdentity,
      addresses: networkService.getListenAddresses(),
      createdAt,
      expiresAt: createdAt + INVITE_TTL_MS,
      nonce: this.createInviteNonce(peerId, localIdentity?.publicIdentity, createdAt),
    };

    return this.serializeInvite(invite);
  }

  parseInvite(uri: string): PeerInvite {
    const trimmed = uri.trim();
    if (!trimmed.startsWith(INVITE_SCHEME) && !trimmed.startsWith(LEGACY_INVITE_SCHEME)) {
      throw new Error('Invalid Synpeer peer invite');
    }

    const queryIndex = trimmed.indexOf('?');
    if (queryIndex < 0) {
      throw new Error('Invite is missing peer data');
    }

    const params = this.parseQuery(trimmed.slice(queryIndex + 1));
    const version = Number(params.v?.[0] ?? '1');
    const peerId = params.peerId?.[0];
    const identityId = params.identityId?.[0];
    const createdAt = Number(params.createdAt?.[0] ?? Date.now());
    const expiresAtRaw = params.expiresAt?.[0];
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : undefined;
    const nonce = params.nonce?.[0];
    const signature = params.signature?.[0];
    const addresses = params.addr ?? [];

    if (version !== 1) {
      throw new Error('Unsupported peer invite version');
    }

    if (!peerId) {
      throw new Error('Invite is missing peer id');
    }

    if (!Number.isFinite(createdAt)) {
      throw new Error('Invite has an invalid creation timestamp');
    }
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= createdAt)) {
      throw new Error('Invite has an invalid expiration timestamp');
    }
    if (expiresAt !== undefined && Date.now() > expiresAt) {
      throw new Error('Peer invite has expired');
    }

    return {
      version: 1,
      peerId,
      identityId,
      addresses,
      createdAt,
      expiresAt,
      nonce,
      signature,
    };
  }

  importInvite(uri: string) {
    const invite = this.parseInvite(uri);
    const localPeerId = this.getLocalPeerId();
    if (localPeerId && invite.peerId === localPeerId) {
      throw new Error('Cannot import your own peer invite');
    }

    return this.repository.upsert({
      peerId: invite.peerId,
      identityId: invite.identityId,
      addresses: invite.addresses,
      source: 'invite',
      trustStatus: 'unknown',
    });
  }

  private serializeInvite(invite: PeerInvite): string {
    const params: Array<[string, string]> = [];
    params.push(['v', String(invite.version)]);
    params.push(['peerId', invite.peerId]);
    if (invite.identityId) {
      params.push(['identityId', invite.identityId]);
    }
    params.push(['createdAt', String(invite.createdAt)]);
    if (invite.expiresAt) {
      params.push(['expiresAt', String(invite.expiresAt)]);
    }
    if (invite.nonce) {
      params.push(['nonce', invite.nonce]);
    }
    for (const address of invite.addresses) {
      params.push(['addr', address]);
    }
    if (invite.signature) {
      params.push(['signature', invite.signature]);
    }
    return `${INVITE_SCHEME}?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
  }

  private parseQuery(query: string): Record<string, string[]> {
    const params: Record<string, string[]> = {};
    for (const part of query.split('&')) {
      if (!part) {
        continue;
      }
      const [rawKey, rawValue = ''] = part.split('=');
      const key = decodeURIComponent(rawKey);
      const value = decodeURIComponent(rawValue);
      params[key] = [...(params[key] ?? []), value];
    }
    return params;
  }

  private createInviteNonce(
    peerId: PeerId,
    identityId: string | undefined,
    createdAt: number,
  ): string {
    return sha256Hex(canonicalize({ peerId, identityId: identityId ?? null, createdAt })).slice(
      0,
      32,
    );
  }
}
