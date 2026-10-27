export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

export type Invitation = {
  id: string;
  groupId: string;
  groupName: string;
  email: string;
  invitedByName: string;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
};

export type CreatedInvitation = {
  invitation: Invitation;
  token: string;
};

export type InvitationRow = {
  id: string;
  group_id: string;
  group_name: string;
  email: string;
  invited_by_name: string;
  status: InvitationStatus;
  created_at: Date;
  expires_at: Date;
};

export function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    email: row.email,
    invitedByName: row.invited_by_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}
