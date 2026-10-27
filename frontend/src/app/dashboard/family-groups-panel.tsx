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

export default function FamilyGroupsPanel({
  group,
  groupsReady,
  onGroupUpdated,
  onLeftGroup,
  onRefreshGroups,
  onSessionExpired,
  onWorkingChange,
  refreshVersion = 0,
}: {
  group: Group | null;
  groupsReady: boolean;
  onGroupUpdated: (group: Group, selectGroup?: boolean) => void;
  onLeftGroup: () => void;
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

  return (
    <section aria-labelledby="family-groups-heading" className="mt-10 border-t border-slate-200 pt-8">
      <h2 className="text-2xl font-semibold text-slate-950" id="family-groups-heading">Familias y miembros</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
        Puedes crear una familia. En una familia existente, el owner administra el nombre y los miembros; cualquier miembro puede consultar el listado.
      </p>

      {notice && <p className="mt-4 rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-900" role="status">{notice}</p>}
      {actionError && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{actionError}</p>}
      {!groupsReady && (
        <p className="mt-4 text-sm text-slate-600" role="status">Actualizando el grupo y sus permisos…</p>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h3 className="text-xl font-semibold text-slate-950">Crear familia</h3>
          <p className="mt-2 text-sm text-slate-600">Crearla no cambia ni elimina tu grupo personal.</p>
          <form className="mt-4 space-y-3" onSubmit={createFamily}>
            <label className="block text-sm font-medium text-slate-700" htmlFor="new-family-name">Nombre</label>
            <input
              className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
              disabled={workingAction !== null}
              id="new-family-name"
              maxLength={255}
              onChange={(event) => setNewGroupName(event.target.value)}
              required
              value={newGroupName}
            />
            <button
              className="min-h-10 rounded-lg bg-violet-700 px-4 text-sm font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={workingAction !== null || !newGroupName.trim()}
              type="submit"
            >
              {workingAction === 'create' ? 'Creando…' : 'Crear familia'}
            </button>
          </form>
        </section>

        {group ? (
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h3 className="text-xl font-semibold text-slate-950">{group.name}</h3>
            <p className="mt-1 text-sm text-slate-600">{isOwner ? 'Owner' : isMember ? 'Miembro' : 'Permisos en actualización'}</p>

            {isOwner && (
              <>
                <form className="mt-5 space-y-3 border-t border-slate-100 pt-5" onSubmit={renameFamily}>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="family-name">Cambiar nombre</label>
                  <input
                    className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
                    disabled={workingAction !== null}
                    id="family-name"
                    maxLength={255}
                    onChange={(event) => setGroupNameDraft(event.target.value)}
                    required
                    value={groupName}
                  />
                  <button className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-60" disabled={workingAction !== null || !groupName.trim() || groupName.trim() === group.name} type="submit">
                    {workingAction === 'rename' ? 'Guardando…' : 'Guardar nombre'}
                  </button>
                </form>

                <form className="mt-5 space-y-3 border-t border-slate-100 pt-5" onSubmit={transferOwnership}>
                  <label className="block text-sm font-medium text-slate-700" htmlFor="new-owner">Transferir propiedad</label>
                  <select
                    className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-950 outline-none focus:border-violet-600 focus:ring-4 focus:ring-violet-100"
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
                  <p className="text-xs text-slate-500">Seguirás como miembro y conservarás tus partes e historial.</p>
                  <button className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-60" disabled={!newOwnerId || workingAction !== null || membersLoading || members.error !== ''} type="submit">
                    {workingAction === 'transfer' ? 'Transfiriendo…' : 'Transferir ownership'}
                  </button>
                </form>
              </>
            )}

            {isMember && (
              <div className="mt-5 border-t border-slate-100 pt-5">
                <p className="text-sm text-slate-600">Si tienes una parte pendiente de un pago pendiente, primero debes resolverla para poder salir.</p>
                <button
                  className="mt-3 min-h-10 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                  disabled={workingAction !== null}
                  onClick={() => void leaveFamily()}
                  type="button"
                >
                  {workingAction === 'leave' ? 'Saliendo…' : 'Salir de la familia'}
                </button>
              </div>
            )}

            {group.role === 'owner' && (
              <p className="mt-5 border-t border-slate-100 pt-5 text-sm text-slate-600">
                Para salir, primero transfiere la propiedad a otro miembro activo.
              </p>
            )}
          </section>
        ) : (
          <section className="rounded-3xl border border-dashed border-slate-300 bg-white p-5 text-sm text-slate-600 sm:p-6">
            Selecciona una familia en el dashboard para consultar sus miembros y administrarla.
          </section>
        )}
      </div>

      {group && (
        <section aria-labelledby="family-members-heading" className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-slate-950" id="family-members-heading">Miembros activos</h3>
              <p className="mt-1 text-sm text-slate-500">Los correos y otros datos privados no se muestran.</p>
            </div>
            <button
              className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              disabled={membersLoading || workingAction !== null || !groupsReady}
              onClick={reloadMembers}
              type="button"
            >
              Actualizar miembros
            </button>
          </div>
          {membersLoading || !groupsReady ? (
            <p className="mt-5 text-sm text-slate-600" role="status">Cargando miembros…</p>
          ) : members.error ? (
            <div className="mt-5 rounded-xl bg-red-50 px-4 py-3">
              <p className="text-sm text-red-700" role="alert">{members.error}</p>
              <button className="mt-3 min-h-9 rounded-lg border border-red-200 px-3 text-sm font-medium text-red-800" onClick={reloadMembers} type="button">
                Reintentar miembros
              </button>
            </div>
          ) : members.members.length === 0 ? (
            <p className="mt-5 rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-600">No hay miembros activos en esta familia.</p>
          ) : (
            <ul className="mt-5 divide-y divide-slate-100">
              {members.members.map((member) => (
                <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between" key={member.userId}>
                  <div>
                    <p className="font-medium text-slate-900">{member.name}</p>
                    <p className="text-sm text-slate-600">{member.role === 'owner' ? 'Owner' : 'Miembro'} · Se unió {new Date(member.joinedAt).toLocaleDateString('es-CR')}</p>
                  </div>
                  {isOwner && member.role !== 'owner' && (
                    <button
                      className="min-h-9 w-fit rounded-lg border border-red-200 px-3 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
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
    </section>
  );
}
