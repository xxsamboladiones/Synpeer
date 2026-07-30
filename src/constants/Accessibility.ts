import { Platform } from 'react-native';

export const ACCESSIBILITY = {
  // Minimum touch target size (WCAG 2.1: 44x44 CSS pixels)
  MIN_TOUCH_TARGET: 44,

  // Font scale support
  SUPPORTS_DYNAMIC_TYPE: Platform.select({
    ios: true,
    android: true,
    default: false,
  }),

  // Screen reader support
  SCREEN_READER_ENABLED: false, // Will be detected at runtime

  // Color contrast ratios (WCAG 2.1)
  CONTRAST_RATIOS: {
    AA_NORMAL: 4.5,
    AA_LARGE: 3,
    AAA_NORMAL: 7,
    AAA_LARGE: 4.5,
  },

  // Accessible colors (high contrast)
  COLORS: {
    PRIMARY_TEXT: '#FFFFFF',
    SECONDARY_TEXT: '#8E8E93',
    DISABLED_TEXT: '#48484A',
    SUCCESS: '#34C759',
    WARNING: '#FF9500',
    ERROR: '#FF3B30',
    INFO: '#007AFF',
  },
};

export const ACCESSIBILITY_HINTS = {
  POST: 'View post details',
  LIKE: 'Like this post',
  COMMENT: 'Comment on this post',
  SHARE: 'Share this post',
  PROFILE: 'View profile',
  SETTINGS: 'Open settings',
  NOTIFICATIONS: 'View notifications',
  CREATE_POST: 'Create new post',
  WALLET: 'View wallet balance',
  CONTRIBUTION: 'View contribution dashboard',
  NETWORK: 'View network status',
};

export const ACCESSIBILITY_LABELS = {
  TAB_FEED: 'Feed',
  TAB_DISCOVER: 'Discover',
  TAB_CREATE: 'Create',
  TAB_CONTRIBUTION: 'Contribution',
  TAB_PROFILE: 'Profile',
  BUTTON_BACK: 'Go back',
  BUTTON_CLOSE: 'Close',
  BUTTON_SAVE: 'Save',
  BUTTON_CANCEL: 'Cancel',
  BUTTON_DELETE: 'Delete',
  BUTTON_EDIT: 'Edit',
  BUTTON_SHARE: 'Share',
  BUTTON_COPY: 'Copy',
};
