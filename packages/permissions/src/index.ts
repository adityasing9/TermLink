import type { PeerRole, TerminalAccessMode } from '../../core/src/index';

export type PermissionAction =
  | 'room:close'
  | 'room:settings'
  | 'room:rotate_code'
  | 'room:transfer_ownership'
  | 'peer:approve'
  | 'peer:invite'
  | 'peer:remove'
  | 'peer:manage_roles'
  | 'peer:manage_admins'
  | 'chat:send'
  | 'chat:moderate'
  | 'file:send'
  | 'file:receive'
  | 'file:approve_group'
  | 'command:propose'
  | 'terminal:create_session'
  | 'terminal:grant_access'
  | 'terminal:view'
  | 'terminal:interact';

export interface RoomPermissionPolicy {
  allowViewerChat: boolean;
  allowGuestFiles: boolean;
  allowCommandProposals: boolean;
  allowPeerAssistedDistribution: boolean;
}

export const DEFAULT_ROOM_POLICY: RoomPermissionPolicy = {
  allowViewerChat: true,
  allowGuestFiles: false,
  allowCommandProposals: true,
  allowPeerAssistedDistribution: false,
};

const ROLE_HIERARCHY: Record<PeerRole, number> = {
  owner: 5,
  admin: 4,
  collaborator: 3,
  viewer: 2,
  guest: 1,
};

const BASE_ROLE_PERMISSIONS: Record<PeerRole, ReadonlySet<PermissionAction>> = {
  owner: new Set<PermissionAction>([
    'room:close',
    'room:settings',
    'room:rotate_code',
    'room:transfer_ownership',
    'peer:approve',
    'peer:invite',
    'peer:remove',
    'peer:manage_roles',
    'peer:manage_admins',
    'chat:send',
    'chat:moderate',
    'file:send',
    'file:receive',
    'file:approve_group',
    'command:propose',
    'terminal:create_session',
    'terminal:grant_access',
    'terminal:view',
    'terminal:interact',
  ]),
  admin: new Set<PermissionAction>([
    'peer:approve',
    'peer:invite',
    'peer:remove',
    'peer:manage_roles',
    'chat:send',
    'chat:moderate',
    'file:send',
    'file:receive',
    'file:approve_group',
    'command:propose',
    'terminal:view',
  ]),
  collaborator: new Set<PermissionAction>([
    'chat:send',
    'file:send',
    'file:receive',
    'command:propose',
    'terminal:view',
  ]),
  viewer: new Set<PermissionAction>([
    'file:receive',
    'terminal:view',
  ]),
  guest: new Set<PermissionAction>([
    'chat:send',
  ]),
};

export function getRoleRank(role: PeerRole): number {
  return ROLE_HIERARCHY[role];
}

export function canPerformAction(
  role: PeerRole,
  action: PermissionAction,
  policy: RoomPermissionPolicy = DEFAULT_ROOM_POLICY,
  terminalAccess: TerminalAccessMode = 'disabled'
): boolean {
  if (action === 'command:propose' && !policy.allowCommandProposals) {
    return false;
  }

  if (action === 'chat:send' && role === 'viewer') {
    return policy.allowViewerChat;
  }

  if ((action === 'file:receive' || action === 'file:send') && role === 'guest') {
    return policy.allowGuestFiles && action === 'file:receive';
  }

  // Terminal interactive execution ALWAYS requires explicit per-peer interactive grant (or being session owner)
  if (action === 'terminal:interact') {
    if (role === 'guest' || role === 'viewer') return false;
    return terminalAccess === 'interactive';
  }

  if (action === 'terminal:view') {
    if (role === 'guest') return false;
    return terminalAccess === 'read-only' || terminalAccess === 'interactive' || role === 'owner';
  }

  return BASE_ROLE_PERMISSIONS[role].has(action);
}

export function canModifyTargetRole(actorRole: PeerRole, targetCurrentRole: PeerRole, targetNewRole: PeerRole): boolean {
  if (actorRole === 'owner') {
    // Owner can change anyone except themselves via role-change (ownership transfer is a separate action)
    return targetCurrentRole !== 'owner' && targetNewRole !== 'owner';
  }
  if (actorRole === 'admin') {
    // Admins cannot modify owner or other admins, and cannot promote to admin/owner
    if (targetCurrentRole === 'owner' || targetCurrentRole === 'admin') return false;
    if (targetNewRole === 'owner' || targetNewRole === 'admin') return false;
    return true;
  }
  return false;
}

export function canRemovePeer(actorRole: PeerRole, targetRole: PeerRole): boolean {
  if (targetRole === 'owner') return false;
  return getRoleRank(actorRole) > getRoleRank(targetRole) && (actorRole === 'owner' || actorRole === 'admin');
}

export function describeRole(role: PeerRole): string {
  switch (role) {
    case 'owner':
      return 'Full room control, security policy, ownership transfer, and terminal session hosting.';
    case 'admin':
      return 'Approve/remove participants, invite peers, moderate chat, and manage non-admin roles.';
    case 'collaborator':
      return 'Group & private chat, direct file transfers, command proposals, and approved terminal sessions.';
    case 'viewer':
      return 'Receive files, view approved read-only terminals, and chat when enabled.';
    case 'guest':
      return 'Restricted temporary access; requires host approval and has no terminal execution rights.';
  }
}
