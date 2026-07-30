import type { PeerId } from './NetworkTypes';

/**
 * Signed packet structure
 */
export interface SignedPacketData<T = unknown> {
  /** Message payload */
  payload: T;
  /** Timestamp when message was created */
  timestamp: number;
  /** Sender peer ID */
  sender: PeerId;
  /** Signature of the packet */
  signature: string;
}

/**
 * Packet verification result
 */
export interface PacketVerificationResult {
  valid: boolean;
  sender?: PeerId;
  error?: string;
}

/**
 * SignedPacket handles creation and verification of signed network packets
 * Every network message must contain: payload, timestamp, sender, signature
 */
export class SignedPacket {
  /**
   * Create a signed packet
   * For phase 2, we'll use a simple hash-based signature
   * In production, this should use proper cryptographic signatures
   */
  static create<T>(payload: T, sender: PeerId, privateKey: string): SignedPacketData<T> {
    const timestamp = Date.now();
    const signature = this.sign(payload, timestamp, sender, privateKey);

    return {
      payload,
      timestamp,
      sender,
      signature,
    };
  }

  /**
   * Sign a packet
   * For phase 2, we'll use a simple hash-based signature
   * In production, this should use proper cryptographic signatures
   */
  private static sign<T>(
    payload: T,
    timestamp: number,
    sender: PeerId,
    privateKey: string,
  ): string {
    const payloadStr = JSON.stringify(payload);
    const data = `${payloadStr}:${timestamp}:${sender}:${privateKey}`;

    // Simple hash-based signature for phase 2
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }

    return Math.abs(hash).toString(16).padStart(16, '0');
  }

  /**
   * Verify a signed packet
   * For phase 2, we'll use the same hash-based verification
   * In production, this should use proper cryptographic verification
   */
  static verify<T>(packet: SignedPacketData<T>, publicKey: string): PacketVerificationResult {
    // Check timestamp is not too old (replay protection)
    const now = Date.now();
    const maxAge = 60000; // 1 minute
    if (now - packet.timestamp > maxAge) {
      return {
        valid: false,
        error: 'Packet timestamp too old (possible replay attack)',
      };
    }

    // Check timestamp is not in the future
    if (packet.timestamp > now + 5000) {
      return {
        valid: false,
        error: 'Packet timestamp in the future',
      };
    }

    // Verify signature
    const expectedSignature = this.sign(packet.payload, packet.timestamp, packet.sender, publicKey);

    if (packet.signature !== expectedSignature) {
      return {
        valid: false,
        error: 'Invalid signature',
      };
    }

    return {
      valid: true,
      sender: packet.sender,
    };
  }

  /**
   * Verify packet without public key (for phase 2)
   * Only checks timestamp and signature format
   */
  static verifyBasic<T>(packet: SignedPacketData<T>): PacketVerificationResult {
    // Check timestamp is not too old (replay protection)
    const now = Date.now();
    const maxAge = 60000; // 1 minute
    if (now - packet.timestamp > maxAge) {
      return {
        valid: false,
        error: 'Packet timestamp too old (possible replay attack)',
      };
    }

    // Check timestamp is not in the future
    if (packet.timestamp > now + 5000) {
      return {
        valid: false,
        error: 'Packet timestamp in the future',
      };
    }

    // Check signature format (16 hex characters)
    if (!/^[0-9a-f]{16}$/i.test(packet.signature)) {
      return {
        valid: false,
        error: 'Invalid signature format',
      };
    }

    return {
      valid: true,
      sender: packet.sender,
    };
  }

  /**
   * Serialize packet to JSON
   */
  static serialize<T>(packet: SignedPacketData<T>): string {
    return JSON.stringify(packet);
  }

  /**
   * Deserialize packet from JSON
   */
  static deserialize<T>(data: string): SignedPacketData<T> | null {
    try {
      return JSON.parse(data) as SignedPacketData<T>;
    } catch {
      return null;
    }
  }

  /**
   * Get packet age in milliseconds
   */
  static getAge<T>(packet: SignedPacketData<T>): number {
    return Date.now() - packet.timestamp;
  }

  /**
   * Check if packet is expired
   */
  static isExpired<T>(packet: SignedPacketData<T>, maxAge: number = 60000): boolean {
    return this.getAge(packet) > maxAge;
  }
}
