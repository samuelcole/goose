import { describe, expect, it } from 'vitest';
import { permissionsPolicyFor } from '../permissionsPolicy';

describe('permissionsPolicyFor', () => {
  it('maps requested resource permissions to Permissions Policy features', () => {
    expect(permissionsPolicyFor({ microphone: {}, clipboardWrite: {} })).toBe(
      'microphone; clipboard-write'
    );
  });

  it('grants nothing when no permissions are requested', () => {
    expect(permissionsPolicyFor(null)).toBe('');
    expect(permissionsPolicyFor({})).toBe('');
  });
});
