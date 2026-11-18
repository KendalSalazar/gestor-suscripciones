'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiWithSession } from '@/lib/api';

type Group = {
  id: string;
  name: string;
  type: 'personal' | 'family';
  ownerId: string;
  role: 'owner' | 'member';
  createdAt: string;
};

type GroupMember = {
  userId: string;
  name: string;
  role: 'owner' | 'member';
  status: 'active';
  joinedAt: string;
};

type MembersState = {
  groupId: string | null;
  ownerId: string | null;
  members: GroupMember[];
  loading: boolean;
  error: string;
  refreshVersion: number;
};

type GroupResponse = { group: Group };
type MembersResponse = { members: GroupMember[] };

const initialMembers: MembersState = { groupId: null, ownerId: null, members: [], loading: true, error: '', refreshVersion: -1 };

function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0] ?? '?');
  const last = Array.from(parts[parts.length - 1] ?? '?');
  const initials = parts.length > 1 ? `${first[0]}${last[0]}` : first.slice(0, 2).join('');
  return initials.toLocaleUpperCase('es-CR');
}

export default function FamilyGroupsPanel({
  createFamilyOpen,
  group,
  groupsReady,
  onGroupUpdated,
  onLeftGroup,
  onCreateFamilyOpenChange,
  onRefreshGroups,
  onSessionExpired,
  onWorkingChange,
  refreshVersion = 0,
}: {
  createFamilyOpen: boolean;
  group: Group | null;
  groupsReady: boolean;
  onGroupUpdated: (group: Group, selectGroup?: boolean) => void;
  onLeftGroup: () => void;
  onCreateFamilyOpenChange: (open: boolean) => void;
  onRefreshGroups: () => void;
  onSessionExpired: () => void;
  onWorkingChange: (working: boolean) => void;
  refreshVersion?: number;
}) {
  const groupId = group?.id ?? null;
  const ownerId = group?.ownerId ?? null;
  const [members, setMembers] = useState<MembersState>(initialMembers);
  const [membersVersion, setMembersVersion] = useState(0);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupNameDraft, setGroupNameDraft] = useState<string | null>(null);
  const groupName = groupNameDraft ?? group?.name ?? '';
  const [newOwnerId, setNewOwnerId] = useState('');
  const [workingAction, setWorkingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const membersLoading = members.groupId !== groupId || members.ownerId !== ownerId || members.loading || members.refreshVersion !== refreshVersion;

  useEffect(() => {
    if (!groupId || !groupsReady) return;
    const controller = new AbortController();

    async function loadMembers() {
      try {
        const result = await apiWithSession<MembersResponse>(`/groups/${groupId}/members`, {
          signal: controller.signal,
        });
        if (!result) throw new Error('El servidor no devolvió los miembros.');
        if (!controller.signal.aborted) {
          setMembers({ groupId, ownerId, members: result.members, loading: false, error: '', refreshVersion });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        if (error instanceof ApiError && error.status === 403) onRefreshGroups();
        setMembers({
          groupId, ownerId, members: [], loading: false, refreshVersion,
          error: error instanceof ApiError && error.status === 403
            ? 'Ya no tienes acceso a este grupo o cambió tu rol. Actualizamos la lista de grupos.'
            : 'No pudimos cargar los miembros de la familia. Inténtalo de nuevo.',
        });
      }
    }

    void loadMembers();
    return () => controller.abort();
  }, [groupId, groupsReady, membersVersion, onRefreshGroups, onSessionExpired, ownerId, refreshVersion]);

  function getActionError(error: unknown, fallback: string): string {
    if (error instanceof ApiError) {
      if (error.status === 400) return 'Revisa los datos e inténtalo de nuevo.';
      if (error.status === 403) {
        onRefreshGroups();
        return 'El permiso del grupo cambió. Actualizamos la lista de grupos.';
      }
      if (error.status === 404) {
        onRefreshGroups();
        return 'La persona o el grupo ya no está disponible. Actualizamos la lista de grupos.';
      }
      if (error.status === 409) {
        return 'El grupo o sus permisos cambiaron. Actualizamos los datos disponibles; revisa el estado e inténtalo de nuevo.';
      }
    }
    return fallback;
  }

  function reloadMembers() {
    if (!groupId) return;
    setMembers({ groupId, ownerId, members: [], loading: true, error: '', refreshVersion });
    setMembersVersion((current) => current + 1);
  }

  async function createFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!name || workingAction) return;
    setWorkingAction('create');
    onWorkingChange(true);
    setActionError('');
    setNotice('');
    try {
      const result = await apiWithSession<GroupResponse>('/groups', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      if (!result) throw new Error('El servidor no devolvió la familia creada.');
      setNewGroupName('');
      onCreateFamilyOpenChange(false);
      setNotice('Familia creada. Ya está seleccionada en el dashboard.');
      onGroupUpdated(result.group, true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setActionError(getActionError(error, 'No pudimos crear la familia. Comprueba la conexión e inténtalo de nuevo.'));
    } finally {
      setWorkingAction(null);
      onWorkingChange(false);
    }
  }

  async function renameFamily(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = groupName.trim();
    if (!group || !name || workingAction || !groupsReady) return;
    setWorkingAction('rename');
    onWorkingChange(true);
    setActionError('');
    setNotice('');
    try {
      const result = await apiWithSession<GroupResponse>(`/groups/${group.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      if (!result) throw new Error('El servidor no devolvió la familia actualizada.');
      setGroupNameDraft(null);
      setNotice('Nombre de la familia actualizado.');
      onGroupUpdated(result.group);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setActionError(getActionError(error, 'No pudimos cambiar el nombre de la familia. Inténtalo de nuevo.'));
    } finally {
      setWorkingAction(null);
      onWorkingChange(false);
    }
  }

  async function transferOwnership(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!group || !newOwnerId || workingAction || !groupsReady) return;
    const nextOwner = members.members.find((member) => member.userId === newOwnerId);
    if (!nextOwner || nextOwner.role !== 'member') return;
    if (!window.confirm(`¿Transferir la propiedad de ${group.name} a ${nextOwner.name}? Seguirás como miembro.`)) return;

    setWorkingAction('transfer');
    onWorkingChange(true);
    setActionError('');
    setNotice('');
    try {
      const result = await apiWithSession<GroupResponse>(`/groups/${group.id}/transfer-ownership`, {
        method: 'POST',
        body: JSON.stringify({ newOwnerId }),
      });
      if (!result) throw new Error('El servidor no devolvió el grupo actualizado.');
      setNewOwnerId('');
      setNotice('La propiedad se transfirió. Ahora tienes permisos de miembro.');
      onGroupUpdated(result.group);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setActionError(getActionError(error, 'No pudimos transferir la propiedad. Inténtalo de nuevo.'));
    } finally {
      setWorkingAction(null);
      onWorkingChange(false);
    }
  }

  async function leaveFamily() {
    if (!group || workingAction || !groupsReady) return;
    if (!window.confirm(`¿Salir de ${group.name}? Si tienes una parte pendiente, el servidor impedirá la salida.`)) return;
    setWorkingAction('leave');
    onWorkingChange(true);
    setActionError('');
    setNotice('');
    try {
      await apiWithSession<null>(`/groups/${group.id}/leave`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onLeftGroup();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setActionError(error instanceof ApiError && error.status === 409
        ? 'No puedes salir mientras tengas una parte pendiente de un pago pendiente. Resuelve esa parte e inténtalo de nuevo.'
        : getActionError(error, 'No pudimos salir de la familia. Inténtalo de nuevo.'));
    } finally {
      setWorkingAction(null);
      onWorkingChange(false);
    }
  }

  async function removeMember(member: GroupMember) {
    if (!group || group.role !== 'owner' || member.role === 'owner' || workingAction || !groupsReady) return;
    if (!window.confirm(`¿Retirar a ${member.name} de ${group.name}? Sus pagos y partes históricas se conservarán.`)) return;
    setWorkingAction(member.userId);
    onWorkingChange(true);
    setActionError('');
    setNotice('');
    try {
      await apiWithSession<null>(`/groups/${group.id}/members/${member.userId}`, { method: 'DELETE' });
      setNotice(`${member.name} salió de la lista de miembros activos. Se conserva el historial.`);
      reloadMembers();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setActionError(error instanceof ApiError && error.status === 409
        ? `${member.name} podría tener una parte pendiente de un pago pendiente. Esa obligación debe resolverse antes de retirar a la persona.`
        : getActionError(error, `No pudimos retirar a ${member.name}. Inténtalo de nuevo.`));
    } finally {
      setWorkingAction(null);
      onWorkingChange(false);
    }
  }

  const isOwner = group?.role === 'owner' && groupsReady;
  const isMember = group?.role === 'member' && groupsReady;
  const createFamilyForm = (
    <form className="family-create-form" onSubmit={createFamily}>
      <label className="app-design-label" htmlFor="new-family-name">Nombre de la familia</label>
      <input
        className="ui-field"
        disabled={workingAction !== null}
        id="new-family-name"
        maxLength={255}
        onChange={(event) => setNewGroupName(event.target.value)}
        required
        value={newGroupName}
      />
      <button className="ui-button" disabled={workingAction !== null || !newGroupName.trim()} type="submit">
        {workingAction === 'create' ? 'Creando…' : 'Crear familia'}
      </button>
    </form>
  );

  return (
    <section aria-labelledby="family-groups-heading" className="family-groups-panel">
      <div className="family-groups-header">
        <div>
          <h2 className="family-groups-heading" id="family-groups-heading">
            {group ? 'Miembros de la familia' : 'Crear una familia'}
          </h2>
          <p className="family-groups-intro">
            {group
              ? `Personas activas de ${group.name} y su rol en el grupo.`
              : 'Crea un espacio para compartir suscripciones. Tu grupo Personal seguirá igual.'}
          </p>
        </div>
      </div>

      <section
        aria-labelledby="family-create-heading"
        className="family-create-panel"
        hidden={!createFamilyOpen}
        id="family-create-panel"
      >
        <div className="family-create-panel-heading">
          <h3 id="family-create-heading">{group ? 'Crear otra familia' : 'Crear una familia'}</h3>
          <p>{group ? 'Esta familia seguirá igual. La nueva se seleccionará al crearla.' : 'Tu espacio Personal seguirá igual. La nueva familia se seleccionará al crearla.'}</p>
        </div>
        {createFamilyForm}
      </section>

      {notice && <p className="ui-feedback family-notice" role="status">{notice}</p>}
      {actionError && <p className="ui-feedback ui-feedback-error family-action-error" role="alert">{actionError}</p>}
      {!groupsReady && (
        <p className="family-member-state" role="status">Actualizando el grupo y sus permisos…</p>
      )}

      {group && (
        <section className="family-current-group" aria-label="Familia actual">
          <div className="family-current-group-copy">
            <span>Familia actual</span>
            <h3>{group.name}</h3>
            <p>{isOwner ? 'Owner' : isMember ? 'Miembro' : 'Permisos en actualización'}</p>
          </div>
          <details className="family-admin-disclosure">
            <summary>Administrar familia</summary>
            <div className="family-admin-disclosure-body">
              <div className="family-admin-controls">
                {isOwner && (
                  <>
                    <form className="family-admin-form" onSubmit={renameFamily}>
                      <label className="app-design-label" htmlFor="family-name">Cambiar nombre</label>
                      <input
                        className="ui-field"
                        disabled={workingAction !== null}
                        id="family-name"
                        maxLength={255}
                        onChange={(event) => setGroupNameDraft(event.target.value)}
                        required
                        value={groupName}
                      />
                      <button className="ui-button ui-button-secondary" disabled={workingAction !== null || !groupName.trim() || groupName.trim() === group.name} type="submit">
                        {workingAction === 'rename' ? 'Guardando…' : 'Guardar nombre'}
                      </button>
                    </form>

                    <form className="family-admin-form" onSubmit={transferOwnership}>
                      <label className="app-design-label" htmlFor="new-owner">Transferir propiedad</label>
                      <select
                        className="ui-field"
                        disabled={membersLoading || members.error !== '' || workingAction !== null}
                        id="new-owner"
                        onChange={(event) => setNewOwnerId(event.target.value)}
                        value={newOwnerId}
                      >
                        <option value="">Selecciona un miembro activo</option>
                        {members.members.filter((member) => member.role === 'member').map((member) => (
                          <option key={member.userId} value={member.userId}>{member.name}</option>
                        ))}
                      </select>
                      <p>Seguirás como miembro y conservarás tus partes e historial.</p>
                      <button className="ui-button ui-button-secondary" disabled={!newOwnerId || workingAction !== null || membersLoading || members.error !== ''} type="submit">
                        {workingAction === 'transfer' ? 'Transfiriendo…' : 'Transferir ownership'}
                      </button>
                    </form>
                  </>
                )}

                {isMember && (
                  <div className="family-admin-form">
                    <p>Si tienes una parte pendiente de un pago pendiente, primero debes resolverla para poder salir.</p>
                    <button
                      className="ui-button ui-button-danger"
                      disabled={workingAction !== null}
                      onClick={() => void leaveFamily()}
                      type="button"
                    >
                      {workingAction === 'leave' ? 'Saliendo…' : 'Salir de la familia'}
                    </button>
                  </div>
                )}

                {group.role === 'owner' && (
                  <p className="family-admin-note">Para salir, primero transfiere la propiedad a otro miembro activo.</p>
                )}
              </div>
            </div>
          </details>
        </section>
      )}

      {group && (
        <section aria-labelledby="family-members-heading" className="family-members-panel">
          <div className="family-members-heading">
            <div>
              <h3 id="family-members-heading">Miembros activos</h3>
              <p>Los correos y otros datos privados no se muestran.</p>
            </div>
            <button
              className="ui-button ui-button-secondary"
              disabled={membersLoading || workingAction !== null || !groupsReady}
              onClick={reloadMembers}
              type="button"
            >
              Actualizar miembros
            </button>
          </div>
          {membersLoading || !groupsReady ? (
            <p className="family-member-state" role="status">Cargando miembros…</p>
          ) : members.error ? (
            <div className="family-member-error">
              <p className="ui-feedback ui-feedback-error" role="alert">{members.error}</p>
              <button className="ui-button ui-button-secondary" onClick={reloadMembers} type="button">
                Reintentar miembros
              </button>
            </div>
          ) : members.members.length === 0 ? (
            <p className="family-member-state">No hay miembros activos en esta familia.</p>
          ) : (
            <ul className="family-member-list">
              {members.members.map((member) => (
                <li className={`family-member-row${isOwner && member.role !== 'owner' ? ' family-member-row-with-action' : ''}`} key={member.userId}>
                  <div className="family-member-identity">
                    <span aria-hidden="true" className="family-member-avatar">{memberInitials(member.name)}</span>
                    <div className="family-member-copy">
                      <p className="family-member-name">{member.name}</p>
                      <p className="family-member-joined">
                        Se unió <time dateTime={member.joinedAt}>{new Date(member.joinedAt).toLocaleDateString('es-CR')}</time>
                      </p>
                    </div>
                  </div>
                  <p className="family-member-role">{member.role === 'owner' ? 'Responsable' : 'Miembro'}</p>
                  {isOwner && member.role !== 'owner' && (
                    <button
                      className="family-member-remove min-h-9 w-fit rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                      disabled={workingAction !== null}
                      onClick={() => void removeMember(member)}
                      type="button"
                    >
                      {workingAction === member.userId ? 'Retirando…' : 'Retirar miembro'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!group && (
        <section className="family-empty-state">
          <div className="family-empty-copy">
            <span aria-hidden="true" className="family-empty-mark">+</span>
            <div>
              <h3>Comparte suscripciones en familia</h3>
              <p>Crear una familia no cambia tu espacio Personal. Después podrás elegirla desde el selector de espacio.</p>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
