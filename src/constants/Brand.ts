export const APP_NAME = 'Synpeer';
export const APP_SLUG = 'synpeer';
export const URI_SCHEME = 'synpeer';
export const LEGACY_URI_SCHEME = 'insta99';

export function hasSupportedUriScheme(value: string): boolean {
  return value.startsWith(`${URI_SCHEME}:`) || value.startsWith(`${LEGACY_URI_SCHEME}:`);
}
