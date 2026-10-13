import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: { query: mockQuery },
}));

import { AppError } from '../../middleware/errorHandler';
import { assertOwner, getActiveMembership } from './membership';

const userId = 'a7e4dc62-0df7-4ff4-a54f-c670455d1151';
const groupId = '08dc3ad7-cf55-4199-9fa3-594003beef20';

describe('group membership authorization', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns the active membership using the authenticated user and URL group', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ group_id: groupId, user_id: userId, role: 'owner', status: 'active' }],
    });

    await expect(getActiveMembership(userId, groupId, 'list')).resolves.toEqual({
      groupId,
      userId,
      role: 'owner',
      status: 'active',
    });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'active'"), [userId, groupId]);
  });

  it('returns 403 when the user has no active membership', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(getActiveMembership(userId, groupId, 'list')).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    });
  });

  it('allows owners and rejects members from write operations', () => {
    expect(() => assertOwner({ groupId, userId, role: 'owner', status: 'active' })).not.toThrow();
    expect(() => assertOwner({ groupId, userId, role: 'member', status: 'active' })).toThrow(AppError);
    expect(() => assertOwner({ groupId, userId, role: 'member', status: 'active' })).toThrow('Forbidden');
  });
});
