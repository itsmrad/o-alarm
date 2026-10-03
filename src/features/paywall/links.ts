import { Platform } from 'react-native';

/** Apple's standard EULA applies unless the owner publishes custom terms. */
const APPLE_STANDARD_EULA = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

export function termsUrl(): string {
  return process.env.EXPO_PUBLIC_TERMS_URL?.trim() || APPLE_STANDARD_EULA;
}

/** No default: a privacy policy must be the owner's own. Hidden until configured. */
export function privacyUrl(): string | null {
  return process.env.EXPO_PUBLIC_PRIVACY_URL?.trim() || null;
}

/** Store subscription settings, used when RevenueCat has no management URL for the customer. */
export function storeSubscriptionsUrl(): string {
  return Platform.OS === 'android'
    ? 'https://play.google.com/store/account/subscriptions'
    : 'https://apps.apple.com/account/subscriptions';
}
