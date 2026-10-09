/**
 * Platform admin console.
 *
 * Full reach across users, businesses, bookings, field sessions, reviews, point
 * wallets, money and the audit trail — the "absolute, unrestricted access" the
 * specification calls for, with the destructive actions confirmed and every one
 * of them recorded.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, withQuery } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import {
  Button,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Modal,
  Money,
  Pagination,
  Select,
  Stars,
  Stat,
  StatusChip,
  useToast,
} from '../ui/primitives.jsx';
import { Console, Footer } from '../ui/Layout.jsx';
import { SECTIONS, accent, hueOf } from '../ui/sections.js';

/** A paged table backed by one endpoint. */
function useList(path, params, deps = []) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get(withQuery(path, { page, limit: 20, ...params }))
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, page, JSON.stringify(params)]);

  useEffect(load, [load, ...deps]);
  return { ...state, page, setPage, reload: load };
}

function Section({ title, action, children }) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
function Overview() {
  const { t, pick, formatDate } = useI18n();
  const messageFor = useErrorMessage();
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get('/admin/overview')
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }, []);

  useEffect(load, [load]);

  if (state.loading) return <Loading rows={5} />;
  if (state.error) return <ErrorNote message={messageFor(state.error)} onRetry={load} />;

  const data = state.data;
  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.totalUsers')} value={data.users.total} note={`${data.users.owner} · ${data.users.client}`} />
        <Stat label={t('admin.totalBusinesses')} value={data.businesses.total} />
        <Stat label={t('admin.bookingsToday')} value={data.bookings.today} />
        <Stat label={t('admin.collected')} value={data.revenuePaid.toFixed(2)} note={t('common.currency')} tone="good" />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('admin.pointsOutstanding')} value={data.gym.pointsOutstanding} />
        <Stat
          label={t('admin.expiringSoon')}
          value={data.gym.pointsExpiringIn30Days}
          tone={data.gym.pointsExpiringIn30Days > 0 ? 'bad' : undefined}
        />
        <Stat label={t('owner.activeSubs')} value={data.gym.activeSubscriptions} />
        <Stat label={t('owner.openSessions')} value={data.fields.openSessions} />
      </div>

      <Section title={t('admin.totalBusinesses')}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {SECTIONS.map((section) => (
            <div key={section} className="panel px-4 py-3" style={accent(section)}>
              <p className="text-2xs text-paper-dim">{t(`section.${section}`)}</p>
              <p className="num text-lg font-bold" style={{ color: hueOf(section) }}>
                {data.businesses[section] ?? 0}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('admin.bookings')}>
        {data.recentBookings.length === 0 ? (
          <Empty title={t('booking.none')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('owner.kind')}</th>
                  <th>{t('common.total')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.recentBookings.map((booking) => (
                  <tr key={booking.id}>
                    <td className="num whitespace-nowrap">{formatDate(booking.startsAt)}</td>
                    <td>{t(`section.${booking.section}`)}</td>
                    <td>
                      <Money amount={booking.totalAmount} />
                    </td>
                    <td>
                      <StatusChip status={booking.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
function Users() {
  const { t } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [filters, setFilters] = useState({ q: '', role: '' });
  const list = useList('/admin/users', filters);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        fullName: editing.fullName,
        email: editing.email,
        role: editing.role,
        gender: editing.gender,
        isActive: editing.isActive,
        ...(editing.password ? { password: editing.password } : {}),
        ...(editing.phone ? { phone: editing.phone } : {}),
      };
      if (editing.id) await api.put(`/admin/users/${editing.id}`, payload);
      else await api.post('/admin/users', { ...payload, password: editing.password });
      toast.success(t('common.saved'));
      setEditing(null);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user) => {
    if (!window.confirm(t('admin.confirmDelete'))) return;
    try {
      await api.delete(`/admin/users/${user.id}`);
      toast.success(t('common.saved'));
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <>
      <Section
        title={t('admin.users')}
        action={
          <div className="flex flex-wrap items-end gap-2">
            <Input
              type="search"
              className="w-48"
              placeholder={t('common.search')}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
            <Select
              className="w-36"
              value={filters.role}
              onChange={(event) => setFilters({ ...filters, role: event.target.value })}
            >
              <option value="">{t('common.all')}</option>
              <option value="admin">{t('admin.role.admin')}</option>
              <option value="owner">{t('admin.role.owner')}</option>
              <option value="client">{t('admin.role.client')}</option>
            </Select>
            <Button
              variant="primary"
              onClick={() =>
                setEditing({ fullName: '', email: '', password: '', role: 'client', gender: 'male', isActive: true })
              }
            >
              {t('admin.newUser')}
            </Button>
          </div>
        }
      >
        {list.loading ? (
          <Loading rows={4} />
        ) : list.error ? (
          <ErrorNote message={messageFor(list.error)} onRetry={list.reload} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('admin.role')}</th>
                  <th>{t('auth.gender')}</th>
                  <th>{t('admin.bookings')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <span className="font-semibold">{user.fullName}</span>
                      <span className="block text-2xs text-paper-faint">{user.email}</span>
                    </td>
                    <td>{t(`admin.role.${user.role}`)}</td>
                    <td className="text-paper-dim">{t(`auth.${user.gender}`)}</td>
                    <td className="num">
                      {user.bookingCount}
                      {user.businessCount > 0 ? (
                        <span className="chip ms-2">{user.businessCount}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`chip ${user.isActive ? 'chip-good' : 'chip-bad'}`}>
                        {user.isActive ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          onClick={() =>
                            setEditing({
                              id: user.id,
                              fullName: user.fullName,
                              email: user.email,
                              role: user.role,
                              gender: user.gender,
                              phone: user.phone || '',
                              isActive: user.isActive,
                              password: '',
                            })
                          }
                        >
                          {t('common.edit')}
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => remove(user)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={list.data?.page ?? 1} pages={list.data?.pages ?? 1} onChange={list.setPage} />
      </Section>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('common.edit') : t('admin.newUser')}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!editing?.fullName || !editing?.email} onClick={save}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('auth.fullName')} required>
              {(props) => (
                <Input {...props} value={editing.fullName} onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} />
              )}
            </Field>
            <Field label={t('auth.email')} required>
              {(props) => (
                <Input {...props} type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
              )}
            </Field>
            <Field label={t('admin.role')}>
              {(props) => (
                <Select {...props} value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                  <option value="client">{t('admin.role.client')}</option>
                  <option value="owner">{t('admin.role.owner')}</option>
                  <option value="admin">{t('admin.role.admin')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('auth.gender')}>
              {(props) => (
                <Select {...props} value={editing.gender} onChange={(e) => setEditing({ ...editing, gender: e.target.value })}>
                  <option value="male">{t('auth.male')}</option>
                  <option value="female">{t('auth.female')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('auth.phone')} hint={t('auth.phoneHint')}>
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  maxLength={10}
                  value={editing.phone || ''}
                  onChange={(e) => setEditing({ ...editing, phone: e.target.value.replace(/\D/g, '') })}
                />
              )}
            </Field>
            <Field
              label={editing.id ? t('admin.resetPassword') : t('auth.password')}
              required={!editing.id}
              hint={t('auth.passwordHint')}
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={editing.password}
                  onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Select
                value={editing.isActive ? 'yes' : 'no'}
                onChange={(e) => setEditing({ ...editing, isActive: e.target.value === 'yes' })}
                aria-label={t('common.status')}
              >
                <option value="yes">{t('common.active')}</option>
                <option value="no">{t('common.inactive')}</option>
              </Select>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
function Businesses() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [filters, setFilters] = useState({ q: '', section: '' });
  const list = useList('/admin/businesses', filters);
  const [reassign, setReassign] = useState(null);
  const [owners, setOwners] = useState([]);

  useEffect(() => {
    api
      .get(withQuery('/admin/users', { role: 'owner', limit: 100 }))
      .then((data) => setOwners(data.items ?? []))
      .catch(() => setOwners([]));
  }, []);

  const setStatus = async (business, isActive) => {
    try {
      await api.patch(`/admin/businesses/${business.id}/status`, { isActive });
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  const bulk = async (isActive) => {
    if (!window.confirm(t('admin.confirmDelete'))) return;
    try {
      const result = await api.post('/admin/businesses/bulk-status', {
        isActive,
        ...(filters.section ? { section: filters.section } : {}),
      });
      toast.success(`${result.updated}`);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  const saveOwner = async () => {
    try {
      await api.patch(`/admin/businesses/${reassign.id}/owner`, { ownerId: Number(reassign.ownerId) });
      toast.success(t('common.saved'));
      setReassign(null);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  const remove = async (business) => {
    if (!window.confirm(t('admin.confirmDelete'))) return;
    try {
      await api.delete(`/admin/businesses/${business.id}`);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <>
      <Section
        title={t('admin.businesses')}
        action={
          <div className="flex flex-wrap items-end gap-2">
            <Input
              type="search"
              className="w-44"
              placeholder={t('common.search')}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
            <Select
              className="w-40"
              value={filters.section}
              onChange={(event) => setFilters({ ...filters, section: event.target.value })}
            >
              <option value="">{t('common.all')}</option>
              {SECTIONS.map((section) => (
                <option key={section} value={section}>
                  {t(`section.${section}`)}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => bulk(true)}>
              {t('admin.enableAll')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => bulk(false)}>
              {t('admin.disableAll')}
            </Button>
          </div>
        }
      >
        {list.loading ? (
          <Loading rows={4} />
        ) : list.error ? (
          <ErrorNote message={messageFor(list.error)} onRetry={list.reload} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('owner.kind')}</th>
                  <th>{t('admin.role.owner')}</th>
                  <th>{t('common.rating')}</th>
                  <th>{t('owner.revenue')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((business) => (
                  <tr key={business.id}>
                    <td>
                      <span className="font-semibold">{pick(business.name)}</span>
                      <span className="block text-2xs text-paper-faint">{business.city}</span>
                    </td>
                    <td>
                      <span className="chip" style={{ borderColor: hueOf(business.section) }}>
                        {t(`section.${business.section}`)}
                      </span>
                    </td>
                    <td className="text-2xs">
                      {business.ownerName}
                      <span className="block text-paper-faint">{business.ownerEmail}</span>
                    </td>
                    <td>
                      {business.rating.count > 0 ? (
                        <Stars value={business.rating.avg} count={business.rating.count} />
                      ) : (
                        <span className="text-2xs text-paper-faint">—</span>
                      )}
                    </td>
                    <td>
                      <Money amount={business.revenuePaid} />
                    </td>
                    <td>
                      <span className={`chip ${business.isActive ? 'chip-good' : 'chip-bad'}`}>
                        {business.isActive ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" onClick={() => setStatus(business, !business.isActive)}>
                          {business.isActive ? t('common.disabled') : t('common.enabled')}
                        </Button>
                        <Button size="sm" onClick={() => setReassign({ id: business.id, ownerId: business.ownerId })}>
                          {t('admin.reassignOwner')}
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => remove(business)}>
                          {t('common.delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={list.data?.page ?? 1} pages={list.data?.pages ?? 1} onChange={list.setPage} />
      </Section>

      <Modal
        open={Boolean(reassign)}
        onClose={() => setReassign(null)}
        title={t('admin.reassignOwner')}
        footer={
          <>
            <Button onClick={() => setReassign(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={saveOwner}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        {reassign ? (
          <Field label={t('admin.role.owner')}>
            {(props) => (
              <Select
                {...props}
                value={reassign.ownerId}
                onChange={(event) => setReassign({ ...reassign, ownerId: event.target.value })}
              >
                {owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.fullName} — {owner.email}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
function Bookings() {
  const { t, formatDate, formatTime } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [filters, setFilters] = useState({ section: '', status: '' });
  const list = useList('/admin/bookings', filters);

  const setStatus = async (booking, status) => {
    try {
      await api.patch(`/admin/bookings/${booking.id}/status`, { status });
      toast.success(t('common.saved'));
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <Section
      title={t('admin.bookings')}
      action={
        <div className="flex gap-2">
          <Select
            className="w-40"
            value={filters.section}
            onChange={(event) => setFilters({ ...filters, section: event.target.value })}
          >
            <option value="">{t('common.all')}</option>
            {SECTIONS.map((section) => (
              <option key={section} value={section}>
                {t(`section.${section}`)}
              </option>
            ))}
          </Select>
          <Select
            className="w-36"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            <option value="">{t('common.all')}</option>
            {['pending', 'confirmed', 'completed', 'cancelled', 'no_show'].map((status) => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {list.loading ? (
        <Loading rows={4} />
      ) : list.error ? (
        <ErrorNote message={messageFor(list.error)} onRetry={list.reload} />
      ) : !list.data.items.length ? (
        <Empty title={t('booking.none')} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('booking.reference')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('owner.kind')}</th>
                  <th>{t('common.name')}</th>
                  <th>{t('common.total')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((booking) => (
                  <tr key={booking.id}>
                    <td className="num text-2xs">{booking.reference}</td>
                    <td className="num whitespace-nowrap">
                      {formatDate(booking.startsAt)} {formatTime(booking.startsAt)}
                    </td>
                    <td className="text-2xs">{t(`section.${booking.section}`)}</td>
                    <td className="text-2xs">{booking.clientName}</td>
                    <td>
                      <Money amount={booking.totalAmount} />
                    </td>
                    <td>
                      <StatusChip status={booking.status} />
                    </td>
                    <td>
                      {booking.status !== 'completed' && booking.status !== 'cancelled' ? (
                        <div className="flex gap-1.5">
                          <Button variant="primary" size="sm" onClick={() => setStatus(booking, 'completed')}>
                            {t('booking.markComplete')}
                          </Button>
                          <Button variant="danger" size="sm" onClick={() => setStatus(booking, 'cancelled')}>
                            {t('common.cancel')}
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pages={list.data.pages} onChange={list.setPage} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
function Points() {
  const { t, formatDate } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const list = useList('/admin/points/wallets', {});
  const [busy, setBusy] = useState(false);
  const [adjust, setAdjust] = useState(null);

  const sweep = async () => {
    setBusy(true);
    try {
      const result = await api.post('/admin/points/sweep', {});
      toast.success(`${result.pointsExpired} ${t('admin.swept')}`);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const saveAdjustment = async () => {
    try {
      await api.post('/admin/points/adjust', {
        userId: adjust.userId,
        businessId: adjust.businessId,
        points: Number(adjust.points),
        note: adjust.note || undefined,
      });
      toast.success(t('common.saved'));
      setAdjust(null);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <>
      <Section
        title={t('admin.points')}
        action={
          <Button variant="primary" busy={busy} onClick={sweep}>
            {t('admin.sweepPoints')}
          </Button>
        }
      >
        {list.loading ? (
          <Loading rows={4} />
        ) : list.error ? (
          <ErrorNote message={messageFor(list.error)} onRetry={list.reload} />
        ) : !list.data.items.length ? (
          <Empty title={t('gym.noBalance')} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('common.name')}</th>
                    <th>{t('section.gym')}</th>
                    <th>{t('gym.balance')}</th>
                    <th>{t('gym.expiresOn')}</th>
                    <th>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((wallet) => (
                    <tr key={`${wallet.userId}-${wallet.businessId}`}>
                      <td>
                        <span className="font-semibold">{wallet.userName}</span>
                        <span className="block text-2xs text-paper-faint">{wallet.email}</span>
                      </td>
                      <td className="text-2xs">{wallet.businessName}</td>
                      <td className="num font-bold" style={{ color: hueOf('gym') }}>
                        {wallet.balance}
                      </td>
                      <td className="num text-2xs text-paper-dim">
                        {wallet.expiresAt ? formatDate(wallet.expiresAt, { year: 'numeric' }) : '—'}
                      </td>
                      <td>
                        <Button
                          size="sm"
                          onClick={() =>
                            setAdjust({
                              userId: wallet.userId,
                              businessId: wallet.businessId,
                              points: 1,
                              note: '',
                            })
                          }
                        >
                          {t('admin.adjustPoints')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={list.data.page} pages={list.data.pages} onChange={list.setPage} />
          </>
        )}
      </Section>

      <Modal
        open={Boolean(adjust)}
        onClose={() => setAdjust(null)}
        title={t('admin.adjustPoints')}
        footer={
          <>
            <Button onClick={() => setAdjust(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={saveAdjustment}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        {adjust ? (
          <div className="grid gap-4">
            <Field label={t('gym.points')} hint="−/+">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  value={adjust.points}
                  onChange={(event) => setAdjust({ ...adjust, points: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('common.notes')}>
              {(props) => (
                <Input {...props} value={adjust.note} onChange={(event) => setAdjust({ ...adjust, note: event.target.value })} />
              )}
            </Field>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
function Reviews() {
  const { t, formatDate } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const list = useList('/admin/reviews', {});

  const remove = async (review) => {
    if (!window.confirm(t('admin.confirmDelete'))) return;
    try {
      await api.delete(`/admin/reviews/${review.id}`);
      list.reload();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <Section title={t('admin.reviews')}>
      {list.loading ? (
        <Loading rows={4} />
      ) : !list.data?.items.length ? (
        <Empty title={t('common.noReviews')} />
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            {list.data.items.map((review) => (
              <div key={review.id} className="row row-quiet flex-col items-start gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold">{review.userName}</span>
                    <Stars value={review.rating} />
                    <span className="text-2xs text-paper-faint">{review.businessName}</span>
                  </div>
                  {review.comment ? <p className="text-2xs text-paper-dim">{review.comment}</p> : null}
                  <span className="num text-2xs text-paper-faint">{formatDate(review.createdAt)}</span>
                </div>
                <Button variant="danger" size="sm" onClick={() => remove(review)}>
                  {t('common.delete')}
                </Button>
              </div>
            ))}
          </div>
          <Pagination page={list.data.page} pages={list.data.pages} onChange={list.setPage} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
function Money_() {
  const { t, formatDate } = useI18n();
  const list = useList('/admin/transactions', {});
  return (
    <Section title={t('admin.money')}>
      {list.loading ? (
        <Loading rows={4} />
      ) : !list.data?.items.length ? (
        <Empty title={t('common.empty')} />
      ) : (
        <>
          <div className="mb-3">
            <Stat label={t('admin.collected')} value={list.data.sumAmount.toFixed(2)} note={t('common.currency')} tone="good" />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('owner.kind')}</th>
                  <th>{t('common.name')}</th>
                  <th>{t('common.total')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((transaction) => (
                  <tr key={transaction.id}>
                    <td className="num whitespace-nowrap">{formatDate(transaction.createdAt)}</td>
                    <td className="text-2xs">{transaction.kind}</td>
                    <td className="text-2xs">
                      {transaction.userName}
                      <span className="block text-paper-faint">{transaction.businessName}</span>
                    </td>
                    <td>
                      <Money amount={transaction.amount} />
                    </td>
                    <td>
                      <StatusChip status={transaction.status === 'paid' ? 'completed' : transaction.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pages={list.data.pages} onChange={list.setPage} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
function Audit() {
  const { t, formatDate, formatTime } = useI18n();
  const list = useList('/admin/audit', {});
  return (
    <Section title={t('admin.audit')}>
      {list.loading ? (
        <Loading rows={4} />
      ) : !list.data?.items.length ? (
        <Empty title={t('common.empty')} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('admin.when')}</th>
                  <th>{t('admin.actor')}</th>
                  <th>{t('admin.action')}</th>
                  <th>{t('admin.entity')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="num whitespace-nowrap text-2xs">
                      {formatDate(entry.createdAt)} {formatTime(entry.createdAt)}
                    </td>
                    <td className="text-2xs">{entry.actorName ?? '—'}</td>
                    <td className="text-2xs font-semibold">{entry.action}</td>
                    <td className="text-2xs text-paper-dim">
                      {entry.entity}
                      {entry.entityId ? <span className="num"> #{entry.entityId}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data.page} pages={list.data.pages} onChange={list.setPage} />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
export default function AdminConsole() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');

  const panels = {
    overview: <Overview />,
    users: <Users />,
    businesses: <Businesses />,
    bookings: <Bookings />,
    reviews: <Reviews />,
    points: <Points />,
    money: <Money_ />,
    audit: <Audit />,
  };

  const rail = [
    ['overview', t('admin.overview')],
    ['users', t('admin.users')],
    ['businesses', t('admin.businesses')],
    ['bookings', t('admin.bookings')],
    ['reviews', t('admin.reviews')],
    ['points', t('admin.points')],
    ['money', t('admin.money')],
    ['audit', t('admin.audit')],
  ].map(([key, label]) => (
    <button key={key} type="button" className="rail-link" aria-current={tab === key} onClick={() => setTab(key)}>
      {label}
    </button>
  ));

  return (
    <>
      <Console subtitle={t('admin.console')} title={user.fullName} rail={rail}>
        {panels[tab]}
      </Console>
      <Footer />
    </>
  );
}
