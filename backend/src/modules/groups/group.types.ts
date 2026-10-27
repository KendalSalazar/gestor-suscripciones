export type Group = {
  id: string;
  name: string;
  type: 'personal' | 'family';
  ownerId: string;
  role: 'owner' | 'member';
  createdAt: string;
};

export type GroupRow = {
  id: string;
  name: string;
  type: 'personal' | 'family';
  owner_id: string;
  role: 'owner' | 'member';
  created_at: Date;
};

export type GroupMember = {
  userId: string;
  name: string;
  role: 'owner' | 'member';
  status: 'active';
  joinedAt: string;
};

export type GroupMemberRow = {
  user_id: string;
  name: string;
  role: 'owner' | 'member';
  status: 'active';
  joined_at: Date;
};

export function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ownerId: row.owner_id,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export function toGroupMember(row: GroupMemberRow): GroupMember {
  return {
    userId: row.user_id,
    name: row.name,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at.toISOString(),
  };
}
