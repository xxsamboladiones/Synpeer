import { BaseModel, SocialModel } from './BaseModel';

/**
 * Timeline cursor for pagination
 */
export interface TimelineCursorData extends BaseModel {
  id: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  signature: string;
  version: string;
  /** Cursor position (timestamp) */
  position: number;
  /** Feed type */
  feedType: 'home' | 'profile' | 'global';
  /** Filter peer ID (for profile feed) */
  filterPeerId?: string;
}

/**
 * Timeline cursor model
 */
export class TimelineCursor extends SocialModel<TimelineCursorData> {
  constructor(data: TimelineCursorData) {
    super(data);
  }

  /**
   * Get cursor position
   */
  getPosition(): number {
    return this.data.position;
  }

  /**
   * Get feed type
   */
  getFeedType(): 'home' | 'profile' | 'global' {
    return this.data.feedType;
  }

  /**
   * Get filter peer ID
   */
  getFilterPeerId(): string | undefined {
    return this.data.filterPeerId;
  }

  /**
   * Validate timeline cursor model
   */
  validate(): boolean {
    return (
      this.validateBase() &&
      this.data.position >= 0 &&
      (this.data.feedType === 'home' ||
        this.data.feedType === 'profile' ||
        this.data.feedType === 'global')
    );
  }

  /**
   * Create a new timeline cursor
   */
  static create(
    author: string,
    position: number,
    feedType: 'home' | 'profile' | 'global',
    filterPeerId?: string,
  ): TimelineCursor {
    const now = Date.now();
    const id = `cursor_${author}_${feedType}_${filterPeerId || 'global'}`;

    return new TimelineCursor({
      id,
      author,
      createdAt: now,
      updatedAt: now,
      signature: '', // To be filled by signing process
      version: '1.0.0',
      position,
      feedType,
      filterPeerId,
    });
  }

  /**
   * Update cursor position
   */
  updatePosition(position: number): TimelineCursor {
    return new TimelineCursor({
      ...this.data,
      position,
      updatedAt: Date.now(),
    });
  }
}
