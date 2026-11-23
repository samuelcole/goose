import type { McpUiResourcePermissions } from '@modelcontextprotocol/ext-apps/app-bridge';

const PERMISSION_POLICY_FEATURES: Record<keyof McpUiResourcePermissions, string> = {
  camera: 'camera',
  microphone: 'microphone',
  geolocation: 'geolocation',
  clipboardWrite: 'clipboard-write',
};

// Permissions Policy features must be delegated at every frame level, so the
// host's iframe allows the same features the proxy grants the guest.
export function permissionsPolicyFor(permissions: McpUiResourcePermissions | null): string {
  if (!permissions) return '';
  return (Object.keys(PERMISSION_POLICY_FEATURES) as Array<keyof McpUiResourcePermissions>)
    .filter((key) => permissions[key])
    .map((key) => PERMISSION_POLICY_FEATURES[key])
    .join('; ');
}
