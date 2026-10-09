/**
 * Owner console.
 *
 * One frame, with the panels that apply to the business's own section: every
 * owner gets details, hours, services, staff and the booking diary; barber and
 * salon owners also get chairs (and salons a polish palette); sports venues get
 * pitches and sessions; gyms get point settings, packages, memberships and
 * members.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, requestLocation, withQuery } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useRouter } from '../router.jsx';
import {
  Button,
  Empty,
  Field,
  Input,
  Loading,
  Modal,
  Money,
  Select,
  Stat,
  StatusChip,
  Switch,
  Textarea,
  useToast,
} from '../ui/primitives.jsx';
import { Console, Footer, Page } from '../ui/Layout.jsx';
import { GOVERNORATES, SECTIONS, TREATMENTS, accent, hueOf } from '../ui/sections.js';

const todayIso = () => new Date().toISOString().slice(0, 10);
const countWords = (text) => (text || '').trim().split(/\s+/).filter(Boolean).length;

/** A section of the console: a heading, an optional action, and a body. */
function Panel({ title, description, action, children }) {
  return (
    <section className="panel mb-5 p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base">{title}</h2>
          {description ? <p className="mt-0.5 text-2xs text-paper-dim">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Business details
// ---------------------------------------------------------------------------
function DetailsPanel({ business, onSaved }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [form, setForm] = useState(() => ({
    nameAr: business.name.ar || '',
    nameEn: business.name.en || '',
    descriptionAr: business.description.ar || '',
    descriptionEn: business.description.en || '',
    phone: business.phone || '',
    governorate: business.governorate || '',
    city: business.city || '',
    address: business.address || '',
    lat: business.lat ?? '',
    lng: business.lng ?? '',
    coverUrl: business.coverUrl || '',
    opensAt: business.opensAt,
    closesAt: business.closesAt,
    slotMinutes: business.slotMinutes,
  }));
  const [busy, setBusy] = useState(false);
  const governorate = GOVERNORATES.find((g) => g.ar === form.governorate);
  const words = countWords(form.descriptionAr);

  const save = async () => {
    setBusy(true);
    try {
      const payload = Object.fromEntries(
        Object.entries(form).filter(([, value]) => value !== '' && value !== null),
      );
      if (payload.lat !== undefined) payload.lat = Number(payload.lat);
      if (payload.lng !== undefined) payload.lng = Number(payload.lng);
      payload.slotMinutes = Number(payload.slotMinutes);
      const updated = await api.put(`/businesses/${business.id}`, payload);
      toast.success(t('common.saved'));
      onSaved(updated);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const locate = async () => {
    try {
      const position = await requestLocation();
      setForm({ ...form, lat: position.lat, lng: position.lng });
    } catch {
      toast.error(t('error.location_required'));
    }
  };

  return (
    <Panel title={t('owner.profile')}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${t('common.name')} (AR)`} required>
          {(props) => (
            <Input {...props} value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} />
          )}
        </Field>
        <Field label={`${t('common.name')} (EN)`}>
          {(props) => (
            <Input {...props} value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field
            label={`${t('owner.description')} (AR)`}
            hint={`${t('owner.descriptionLimit')} — ${words} ${t('owner.wordsUsed')}`}
            error={words > 200 ? t('owner.descriptionLimit') : undefined}
          >
            {(props) => (
              <Textarea
                {...props}
                value={form.descriptionAr}
                onChange={(e) => setForm({ ...form, descriptionAr: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={`${t('owner.description')} (EN)`}>
            {(props) => (
              <Textarea
                {...props}
                value={form.descriptionEn}
                onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label={t('auth.phone')} hint={t('auth.phoneHint')}>
          {(props) => (
            <Input
              {...props}
              inputMode="numeric"
              maxLength={10}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })}
            />
          )}
        </Field>
        <Field label={t('owner.coverImage')}>
          {(props) => (
            <Input {...props} value={form.coverUrl} onChange={(e) => setForm({ ...form, coverUrl: e.target.value })} />
          )}
        </Field>
        <Field label={t('auth.governorate')}>
          {(props) => (
            <Select
              {...props}
              value={form.governorate}
              onChange={(e) => setForm({ ...form, governorate: e.target.value, city: '' })}
            >
              <option value="">—</option>
              {GOVERNORATES.map((item) => (
                <option key={item.ar} value={item.ar}>
                  {locale === 'ar' ? item.ar : item.en}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('auth.city')}>
          {(props) => (
            <Select {...props} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })}>
              <option value="">—</option>
              {governorate?.cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('owner.location')}>
            {(props) => (
              <Input {...props} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            )}
          </Field>
        </div>
        <Field label="Latitude">
          {(props) => (
            <Input {...props} inputMode="decimal" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />
          )}
        </Field>
        <Field label="Longitude">
          {(props) => (
            <Input {...props} inputMode="decimal" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />
          )}
        </Field>
        <Field label={t('owner.opens')}>
          {(props) => (
            <Input {...props} type="time" value={form.opensAt} onChange={(e) => setForm({ ...form, opensAt: e.target.value })} />
          )}
        </Field>
        <Field label={t('owner.closes')}>
          {(props) => (
            <Input {...props} type="time" value={form.closesAt} onChange={(e) => setForm({ ...form, closesAt: e.target.value })} />
          )}
        </Field>
        <Field label={t('owner.slotLength')} hint={t('common.minutes')}>
          {(props) => (
            <Input
              {...props}
              type="number"
              min={5}
              max={240}
              step={5}
              value={form.slotMinutes}
              onChange={(e) => setForm({ ...form, slotMinutes: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 border-t border-ink-line pt-4">
        <Button variant="primary" busy={busy} disabled={words > 200} onClick={save}>
          {t('common.save')}
        </Button>
        <Button onClick={locate}>{t('owner.useGps')}</Button>
        {form.lat && form.lng ? (
          <a
            href={`https://www.google.com/maps?q=${form.lat},${form.lng}`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
          >
            {t('owner.openInMaps')}
          </a>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------
function HoursPanel({ business, onSaved }) {
  const { t } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [hours, setHours] = useState(() =>
    Array.from({ length: 7 }, (_, weekday) => {
      const existing = business.hours?.find((h) => h.weekday === weekday);
      return {
        weekday,
        isClosed: existing?.isClosed ?? false,
        opensAt: existing?.opensAt || business.opensAt,
        closesAt: existing?.closesAt || business.closesAt,
      };
    }),
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/businesses/${business.id}/hours`, { hours });
      toast.success(t('common.saved'));
      onSaved();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={t('owner.hours')}
      action={
        <Button variant="primary" size="sm" busy={busy} onClick={save}>
          {t('common.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {hours.map((day, index) => (
          <div
            key={day.weekday}
            className="flex flex-wrap items-center gap-3 rounded-chip border border-ink-line px-3 py-2.5"
          >
            <span className="w-20 shrink-0 text-xs font-semibold">{t(`weekday.${day.weekday}`)}</span>
            <Switch
              checked={!day.isClosed}
              label={day.isClosed ? t('common.closed') : t('common.open')}
              onChange={(open) => {
                const next = [...hours];
                next[index] = { ...day, isClosed: !open };
                setHours(next);
              }}
            />
            {!day.isClosed ? (
              <span className="ms-auto flex items-center gap-2">
                <input
                  type="time"
                  className="control num w-28"
                  value={day.opensAt}
                  onChange={(event) => {
                    const next = [...hours];
                    next[index] = { ...day, opensAt: event.target.value };
                    setHours(next);
                  }}
                />
                <span className="text-paper-faint">—</span>
                <input
                  type="time"
                  className="control num w-28"
                  value={day.closesAt}
                  onChange={(event) => {
                    const next = [...hours];
                    next[index] = { ...day, closesAt: event.target.value };
                    setHours(next);
                  }}
                />
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
function ServicesPanel({ business, onChanged }) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const blank = {
    kind: business.section === 'dental' ? 'treatment' : 'service',
    nameAr: '',
    nameEn: '',
    description: '',
    price: 0,
    discountPercent: 0,
    durationMin: 30,
    treatmentCode: '',
    bookingType: '',
    nailScope: '',
    stockQty: '',
    isActive: true,
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        kind: editing.kind,
        nameAr: editing.nameAr,
        price: Number(editing.price),
        discountPercent: Number(editing.discountPercent) || 0,
        durationMin: Number(editing.durationMin) || 30,
        isActive: editing.isActive,
        ...(editing.nameEn ? { nameEn: editing.nameEn } : {}),
        ...(editing.description ? { description: editing.description } : {}),
        ...(editing.treatmentCode ? { treatmentCode: editing.treatmentCode } : {}),
        ...(editing.bookingType ? { bookingType: editing.bookingType } : {}),
        ...(editing.nailScope ? { nailScope: editing.nailScope } : {}),
        ...(editing.stockQty !== '' ? { stockQty: Number(editing.stockQty) } : {}),
      };
      if (editing.id) await api.put(`/businesses/${business.id}/services/${editing.id}`, payload);
      else await api.post(`/businesses/${business.id}/services`, payload);
      toast.success(t('common.saved'));
      setEditing(null);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (service) => {
    if (!window.confirm(t('admin.confirmDelete'))) return;
    try {
      await api.delete(`/businesses/${business.id}/services/${service.id}`);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <>
      <Panel
        title={t('owner.services')}
        action={
          <Button variant="primary" size="sm" onClick={() => setEditing(blank)}>
            {t('common.add')}
          </Button>
        }
      >
        {(business.services ?? []).length === 0 ? (
          <Empty title={t('common.empty')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('owner.kind')}</th>
                  <th>{t('common.price')}</th>
                  <th>{t('owner.duration')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {business.services.map((service) => (
                  <tr key={service.id}>
                    <td>
                      <span className="font-semibold">{pick(service.name)}</span>
                      {service.treatmentCode ? (
                        <span className="chip ms-2">{t(`treatment.${service.treatmentCode}`)}</span>
                      ) : null}
                      {service.bookingType === 'groom' ? (
                        <span className="chip ms-2">{t('booking.groom')}</span>
                      ) : null}
                    </td>
                    <td className="text-paper-dim">{service.kind}</td>
                    <td>
                      <Money amount={service.finalPrice} />
                      {service.discountPercent > 0 ? (
                        <span className="num ms-2 text-2xs text-paper-faint">−{service.discountPercent}%</span>
                      ) : null}
                    </td>
                    <td className="num">
                      {service.durationMin} {t('common.minutes')}
                    </td>
                    <td>
                      <span className={`chip ${service.isActive ? 'chip-good' : ''}`}>
                        {service.isActive ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          onClick={() =>
                            setEditing({
                              id: service.id,
                              kind: service.kind,
                              nameAr: service.name.ar,
                              nameEn: service.name.en || '',
                              description: service.description || '',
                              price: service.price,
                              discountPercent: service.discountPercent,
                              durationMin: service.durationMin,
                              treatmentCode: service.treatmentCode || '',
                              bookingType: service.bookingType || '',
                              nailScope: service.nailScope || '',
                              stockQty: service.stockQty ?? '',
                              isActive: service.isActive,
                            })
                          }
                        >
                          {t('common.edit')}
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => remove(service)}>
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
      </Panel>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? t('common.edit') : t('common.add')}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!editing?.nameAr} onClick={save}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`${t('common.name')} (AR)`} required>
              {(props) => (
                <Input {...props} value={editing.nameAr} onChange={(e) => setEditing({ ...editing, nameAr: e.target.value })} />
              )}
            </Field>
            <Field label={`${t('common.name')} (EN)`}>
              {(props) => (
                <Input {...props} value={editing.nameEn} onChange={(e) => setEditing({ ...editing, nameEn: e.target.value })} />
              )}
            </Field>
            <Field label={t('owner.kind')}>
              {(props) => (
                <Select {...props} value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
                  {['service', 'product', 'treatment', 'package', 'training'].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('common.price')} required>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  step="0.01"
                  value={editing.price}
                  onChange={(e) => setEditing({ ...editing, price: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('owner.discount')}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  max={100}
                  value={editing.discountPercent}
                  onChange={(e) => setEditing({ ...editing, discountPercent: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('owner.duration')} hint={t('common.minutes')}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={5}
                  step={5}
                  value={editing.durationMin}
                  onChange={(e) => setEditing({ ...editing, durationMin: e.target.value })}
                />
              )}
            </Field>

            {business.section === 'dental' ? (
              <Field label={t('booking.treatment')}>
                {(props) => (
                  <Select
                    {...props}
                    value={editing.treatmentCode}
                    onChange={(e) => setEditing({ ...editing, treatmentCode: e.target.value })}
                  >
                    <option value="">—</option>
                    {TREATMENTS.map((code) => (
                      <option key={code} value={code}>
                        {t(`treatment.${code}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            {business.section === 'barber' ? (
              <Field label={t('booking.type')}>
                {(props) => (
                  <Select
                    {...props}
                    value={editing.bookingType}
                    onChange={(e) => setEditing({ ...editing, bookingType: e.target.value })}
                  >
                    <option value="">—</option>
                    <option value="regular">{t('booking.regular')}</option>
                    <option value="groom">{t('booking.groom')}</option>
                  </Select>
                )}
              </Field>
            ) : null}
            {business.section === 'salon' ? (
              <Field label={t('booking.nailScope')}>
                {(props) => (
                  <Select
                    {...props}
                    value={editing.nailScope}
                    onChange={(e) => setEditing({ ...editing, nailScope: e.target.value })}
                  >
                    <option value="">—</option>
                    <option value="hands">{t('booking.hands')}</option>
                    <option value="feet">{t('booking.feet')}</option>
                    <option value="both">{t('booking.both')}</option>
                  </Select>
                )}
              </Field>
            ) : null}
            {editing.kind === 'product' ? (
              <Field label={t('owner.stock')}>
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={0}
                    value={editing.stockQty}
                    onChange={(e) => setEditing({ ...editing, stockQty: e.target.value })}
                  />
                )}
              </Field>
            ) : null}
            <div className="sm:col-span-2">
              <Field label={t('owner.description')}>
                {(props) => (
                  <Textarea
                    {...props}
                    value={editing.description}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Switch
                checked={editing.isActive}
                label={t('owner.visible')}
                onChange={(value) => setEditing({ ...editing, isActive: value })}
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff and chairs
// ---------------------------------------------------------------------------
function StaffPanel({ business, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        name: editing.name,
        isActive: editing.isActive,
        ...(editing.roleTitle ? { roleTitle: editing.roleTitle } : {}),
        ...(editing.bio ? { bio: editing.bio } : {}),
        ...(editing.gender ? { gender: editing.gender } : {}),
      };
      if (editing.id) await api.put(`/businesses/${business.id}/staff/${editing.id}`, payload);
      else await api.post(`/businesses/${business.id}/staff`, payload);
      toast.success(t('common.saved'));
      setEditing(null);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member) => {
    if (!window.confirm(t('admin.confirmDelete'))) return;
    try {
      await api.delete(`/businesses/${business.id}/staff/${member.id}`);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <>
      <Panel
        title={t('owner.staff')}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setEditing({ name: '', roleTitle: '', bio: '', gender: '', isActive: true })}
          >
            {t('common.add')}
          </Button>
        }
      >
        {(business.staff ?? []).length === 0 ? (
          <Empty title={t('common.empty')} />
        ) : (
          <div className="flex flex-col gap-2">
            {business.staff.map((member) => (
              <div key={member.id} className="row row-quiet justify-between">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-bold">{member.name}</span>
                  <span className="truncate text-2xs text-paper-faint">{member.roleTitle}</span>
                </span>
                <span className="num text-2xs text-paper-dim">
                  {member.rating.count > 0 ? `${member.rating.avg.toFixed(1)} (${member.rating.count})` : '—'}
                </span>
                <span className="flex gap-1.5">
                  <Button
                    size="sm"
                    onClick={() =>
                      setEditing({
                        id: member.id,
                        name: member.name,
                        roleTitle: member.roleTitle || '',
                        bio: member.bio || '',
                        gender: member.gender || '',
                        isActive: member.isActive,
                      })
                    }
                  >
                    {t('common.edit')}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => remove(member)}>
                    {t('common.delete')}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={t('owner.staff')}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!editing?.name} onClick={save}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.name')} required>
              {(props) => (
                <Input {...props} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              )}
            </Field>
            <Field label={t('admin.role')}>
              {(props) => (
                <Input
                  {...props}
                  value={editing.roleTitle}
                  onChange={(e) => setEditing({ ...editing, roleTitle: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('auth.gender')}>
              {(props) => (
                <Select {...props} value={editing.gender} onChange={(e) => setEditing({ ...editing, gender: e.target.value })}>
                  <option value="">—</option>
                  <option value="male">{t('auth.male')}</option>
                  <option value="female">{t('auth.female')}</option>
                </Select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('common.notes')}>
                {(props) => (
                  <Textarea {...props} value={editing.bio} onChange={(e) => setEditing({ ...editing, bio: e.target.value })} />
                )}
              </Field>
            </div>
            <Switch
              checked={editing.isActive}
              label={t('common.active')}
              onChange={(value) => setEditing({ ...editing, isActive: value })}
            />
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function ChairsPanel({ business, onChanged }) {
  const { t } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [count, setCount] = useState(business.chairs?.length ?? 0);
  const [busy, setBusy] = useState(false);

  const setChairCount = async () => {
    setBusy(true);
    try {
      await api.put(`/businesses/${business.id}/chairs/count`, { count: Number(count) });
      toast.success(t('common.saved'));
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const assign = async (chair, staffId) => {
    try {
      await api.put(`/businesses/${business.id}/chairs/${chair.id}`, {
        staffId: staffId ? Number(staffId) : null,
      });
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <Panel
      title={t('owner.chairs')}
      description={t('owner.assignedTo')}
      action={
        <span className="flex items-end gap-2">
          <Input
            type="number"
            min={0}
            max={60}
            className="w-20"
            value={count}
            onChange={(event) => setCount(event.target.value)}
            aria-label={t('owner.chairCount')}
          />
          <Button variant="primary" size="sm" busy={busy} onClick={setChairCount}>
            {t('owner.setChairCount')}
          </Button>
        </span>
      }
    >
      {(business.chairs ?? []).length === 0 ? (
        <Empty title={t('common.empty')} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {business.chairs.map((chair) => (
            <div key={chair.id} className="flex items-center gap-3 rounded-chip border border-ink-line px-3 py-2.5">
              <span className="shrink-0 text-xs font-bold">{chair.label}</span>
              <Select
                className="ms-auto w-44"
                value={chair.staffId ?? ''}
                onChange={(event) => assign(chair, event.target.value)}
                aria-label={t('owner.assignedTo')}
              >
                <option value="">—</option>
                {(business.staff ?? []).map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function NailColorsPanel({ business, onChanged }) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [form, setForm] = useState({ nameAr: '', hex: '#C0172B' });

  const add = async () => {
    try {
      await api.post(`/businesses/${business.id}/nail-colors`, form);
      setForm({ nameAr: '', hex: '#C0172B' });
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  const remove = async (color) => {
    try {
      await api.delete(`/businesses/${business.id}/nail-colors/${color.id}`);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  return (
    <Panel title={t('owner.colors')} description={t('booking.nailColors')}>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={t('common.name')}>
          {(props) => (
            <Input
              {...props}
              className="w-44"
              value={form.nameAr}
              onChange={(event) => setForm({ ...form, nameAr: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('common.filter')}>
          {(props) => (
            <input
              {...props}
              type="color"
              className="control h-10 w-20 p-1"
              value={form.hex}
              onChange={(event) => setForm({ ...form, hex: event.target.value })}
            />
          )}
        </Field>
        <Button variant="primary" disabled={!form.nameAr} onClick={add}>
          {t('common.add')}
        </Button>
      </div>
      {(business.nailColors ?? []).length === 0 ? (
        <Empty title={t('common.empty')} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {business.nailColors.map((color) => (
            <span key={color.id} className="flex items-center gap-2 rounded-chip border border-ink-line px-2.5 py-1.5">
              <span
                aria-hidden="true"
                className="size-4 rounded-full border border-white/20"
                style={{ background: color.hex }}
              />
              <span className="text-2xs">{pick(color.name)}</span>
              <button
                type="button"
                onClick={() => remove(color)}
                className="text-paper-faint transition-colors hover:text-bad"
                aria-label={t('common.delete')}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Booking diary
// ---------------------------------------------------------------------------
function DiaryPanel({ business }) {
  const { t, formatDate, formatTime } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [date, setDate] = useState('');
  const [state, setState] = useState({ loading: true, data: null });
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get(withQuery(`/bookings/business/${business.id}`, { date: date || undefined, limit: 50 }))
      .then((data) => setState({ loading: false, data }))
      .catch(() => setState({ loading: false, data: null }));
  }, [business.id, date]);

  useEffect(load, [load]);

  const act = async (booking, action) => {
    setBusy(booking.id);
    try {
      await api.post(`/bookings/${booking.id}/${action}`, {});
      toast.success(t('common.saved'));
      load();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={t('owner.diary')}
      description={t('review.afterOnly')}
      action={
        <Input
          type="date"
          className="w-44"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          aria-label={t('common.date')}
        />
      }
    >
      {state.loading ? (
        <Loading rows={3} />
      ) : !state.data?.items.length ? (
        <Empty title={t('booking.none')} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('common.name')}</th>
                <th>{t('owner.services')}</th>
                <th>{t('common.total')}</th>
                <th>{t('common.status')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((booking) => (
                <tr key={booking.id}>
                  <td className="num whitespace-nowrap">
                    {formatDate(booking.startsAt)} {formatTime(booking.startsAt)}
                  </td>
                  <td>
                    <span className="font-semibold">{booking.clientName}</span>
                    {booking.clientPhone ? (
                      <span className="num block text-2xs text-paper-faint">{booking.clientPhone}</span>
                    ) : null}
                  </td>
                  <td className="text-2xs text-paper-dim">
                    {(booking.items ?? []).map((item) => item.label).join('، ')}
                    {booking.treatmentCode ? t(`treatment.${booking.treatmentCode}`) : ''}
                    {booking.bookingType === 'groom' ? ` — ${t('booking.groom')}` : ''}
                    {booking.nailScope ? ` — ${t(`booking.${booking.nailScope}`)}` : ''}
                    {(booking.colours ?? []).length ? (
                      <span className="ms-1 inline-flex gap-1 align-middle">
                        {booking.colours.map((colour, index) => (
                          <span
                            key={index}
                            className="inline-block size-3 rounded-full border border-white/20"
                            style={{ background: colour.hex_code }}
                            title={colour.name_ar}
                          />
                        ))}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <Money amount={booking.totalAmount} />
                  </td>
                  <td>
                    <StatusChip status={booking.status} />
                  </td>
                  <td>
                    <div className="flex gap-1.5">
                      {booking.status === 'confirmed' || booking.status === 'pending' ? (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            busy={busy === booking.id}
                            onClick={() => act(booking, 'complete')}
                          >
                            {t('booking.markComplete')}
                          </Button>
                          <Button size="sm" onClick={() => act(booking, 'no-show')}>
                            {t('booking.noShow')}
                          </Button>
                          <Button variant="danger" size="sm" onClick={() => act(booking, 'cancel')}>
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Sports fields: pitches and sessions
// ---------------------------------------------------------------------------
function FieldsPanel({ business }) {
  const { t, formatDate, formatTime } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [fields, setFields] = useState([]);
  const [selected, setSelected] = useState(null);
  const [slots, setSlots] = useState([]);
  const [newField, setNewField] = useState(null);
  const [series, setSeries] = useState({
    startDate: todayIso(),
    days: 7,
    times: '18:00, 19:30, 21:00',
    durationMin: 90,
  });
  const [busy, setBusy] = useState(false);

  const loadFields = useCallback(() => {
    api
      .get(`/businesses/${business.id}`)
      .then((data) => {
        setFields(data.fields ?? []);
        setSelected((current) => current ?? data.fields?.[0]?.id ?? null);
      })
      .catch(() => setFields([]));
  }, [business.id]);

  const loadSlots = useCallback(() => {
    if (!selected) return;
    api
      .get(`/fields/${selected}/slots/manage`)
      .then((data) => setSlots(data.items ?? []))
      .catch(() => setSlots([]));
  }, [selected]);

  useEffect(loadFields, [loadFields]);
  useEffect(loadSlots, [loadSlots]);

  const createField = async () => {
    setBusy(true);
    try {
      await api.post(`/fields/business/${business.id}`, {
        name: newField.name,
        pricePerPerson: Number(newField.pricePerPerson),
        requiredPlayers: Number(newField.requiredPlayers),
        ...(newField.surface ? { surface: newField.surface } : {}),
        ...(newField.description ? { description: newField.description } : {}),
      });
      toast.success(t('common.saved'));
      setNewField(null);
      loadFields();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const publishSeries = async () => {
    setBusy(true);
    try {
      const result = await api.post(`/fields/${selected}/slots/bulk`, {
        startDate: series.startDate,
        days: Number(series.days),
        times: series.times.split(',').map((time) => time.trim()).filter(Boolean),
        durationMin: Number(series.durationMin),
      });
      toast.success(`${result.createdCount} ${t('owner.openSessions')}`);
      loadSlots();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const act = async (slot, action) => {
    try {
      await api.post(`/fields/slots/${slot.id}/${action}`, {});
      toast.success(t('common.saved'));
      loadSlots();
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  const words = countWords(newField?.description);

  return (
    <>
      <Panel
        title={t('owner.fields')}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              setNewField({ name: '', surface: '', pricePerPerson: 5, requiredPlayers: 14, description: '' })
            }
          >
            {t('common.add')}
          </Button>
        }
      >
        {fields.length === 0 ? (
          <Empty title={t('common.empty')} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {fields.map((field) => (
              <button
                key={field.id}
                type="button"
                onClick={() => setSelected(field.id)}
                aria-pressed={selected === field.id}
                className={`rounded-chip border px-3 py-2 text-xs font-semibold transition-colors ${
                  selected === field.id ? 'border-brass bg-ink-high text-paper' : 'border-ink-line text-paper-dim'
                }`}
              >
                {field.name}
                <span className="num ms-2 text-paper-faint">
                  {field.requiredPlayers} {t('quota.players')}
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      {selected ? (
        <>
          <Panel title={t('owner.publishSeries')}>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label={t('common.from')}>
                {(props) => (
                  <Input
                    {...props}
                    type="date"
                    value={series.startDate}
                    onChange={(e) => setSeries({ ...series, startDate: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('owner.days')}>
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    max={60}
                    value={series.days}
                    onChange={(e) => setSeries({ ...series, days: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('owner.sessionTimes')} hint="18:00, 19:30">
                {(props) => (
                  <Input {...props} value={series.times} onChange={(e) => setSeries({ ...series, times: e.target.value })} />
                )}
              </Field>
              <Field label={t('owner.duration')} hint={t('common.minutes')}>
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={15}
                    step={15}
                    value={series.durationMin}
                    onChange={(e) => setSeries({ ...series, durationMin: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Button variant="primary" className="mt-4" busy={busy} onClick={publishSeries}>
              {t('owner.publishSession')}
            </Button>
          </Panel>

          <Panel title={t('owner.openSessions')}>
            {slots.length === 0 ? (
              <Empty title={t('home.noSessions')} />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('common.date')}</th>
                      <th>{t('quota.players')}</th>
                      <th>{t('common.price')}</th>
                      <th>{t('common.status')}</th>
                      <th>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slots.slice(0, 40).map((slot) => (
                      <tr key={slot.id}>
                        <td className="num whitespace-nowrap">
                          {formatDate(slot.startsAt)} {formatTime(slot.startsAt)}
                        </td>
                        <td>
                          <span className="num font-bold">
                            {slot.joinedPlayers}/{slot.requiredPlayers}
                          </span>
                          {(slot.participants ?? []).length ? (
                            <span className="block text-2xs text-paper-faint">
                              {slot.participants.map((p) => p.userName).slice(0, 3).join('، ')}
                              {slot.participants.length > 3 ? '…' : ''}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <Money amount={slot.pricePerPerson} />
                        </td>
                        <td>
                          <StatusChip status={slot.status} />
                        </td>
                        <td>
                          <div className="flex gap-1.5">
                            {slot.status !== 'completed' && slot.status !== 'cancelled' ? (
                              <>
                                <Button variant="primary" size="sm" onClick={() => act(slot, 'complete')}>
                                  {t('owner.markPlayed')}
                                </Button>
                                <Button variant="danger" size="sm" onClick={() => act(slot, 'cancel')}>
                                  {t('owner.cancelSession')}
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      ) : null}

      <Modal
        open={Boolean(newField)}
        onClose={() => setNewField(null)}
        title={t('owner.fields')}
        footer={
          <>
            <Button onClick={() => setNewField(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!newField?.name || words > 200} onClick={createField}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {newField ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.name')} required>
              {(props) => (
                <Input {...props} value={newField.name} onChange={(e) => setNewField({ ...newField, name: e.target.value })} />
              )}
            </Field>
            <Field label={t('owner.kind')}>
              {(props) => (
                <Select
                  {...props}
                  value={newField.surface}
                  onChange={(e) => setNewField({ ...newField, surface: e.target.value })}
                >
                  <option value="">—</option>
                  {['grass', 'artificial', 'indoor', 'sand'].map((surface) => (
                    <option key={surface} value={surface}>
                      {surface}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('owner.pricePerPerson')} required>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  step="0.01"
                  value={newField.pricePerPerson}
                  onChange={(e) => setNewField({ ...newField, pricePerPerson: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('owner.requiredPlayers')} required>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={2}
                  max={60}
                  value={newField.requiredPlayers}
                  onChange={(e) => setNewField({ ...newField, requiredPlayers: e.target.value })}
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field
                label={t('owner.description')}
                hint={`${t('owner.descriptionLimit')} — ${words} ${t('owner.wordsUsed')}`}
                error={words > 200 ? t('owner.descriptionLimit') : undefined}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    value={newField.description}
                    onChange={(e) => setNewField({ ...newField, description: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Gym: settings, packages, plans, members
// ---------------------------------------------------------------------------
function GymPanel({ business, onChanged }) {
  const { t, pick, formatDate } = useI18n();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [settings, setSettings] = useState(null);
  const [members, setMembers] = useState([]);
  const [pack, setPack] = useState(null);
  const [plan, setPlan] = useState(null);
  const [grant, setGrant] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (business.gymSettings) {
      setSettings({
        pointsPerEntry: business.gymSettings.pointsPerEntry,
        expiryMonths: business.gymSettings.expiryMonths,
        allowsPoints: business.gymSettings.allowsPoints,
        allowsMonthly: business.gymSettings.allowsMonthly,
        introAr: business.gymSettings.intro?.ar || '',
      });
    }
    api
      .get(`/gyms/${business.id}/members`)
      .then((data) => setMembers(data.items ?? []))
      .catch(() => setMembers([]));
  }, [business]);

  const saveSettings = async () => {
    setBusy(true);
    try {
      await api.put(`/gyms/${business.id}/settings`, {
        pointsPerEntry: Number(settings.pointsPerEntry),
        expiryMonths: Number(settings.expiryMonths),
        allowsPoints: settings.allowsPoints,
        allowsMonthly: settings.allowsMonthly,
        introAr: settings.introAr,
      });
      toast.success(t('common.saved'));
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const savePackage = async () => {
    setBusy(true);
    try {
      const payload = {
        nameAr: pack.nameAr,
        points: Number(pack.points),
        bonusPoints: Number(pack.bonusPoints) || 0,
        price: Number(pack.price),
        isActive: true,
      };
      if (pack.id) await api.put(`/gyms/${business.id}/packages/${pack.id}`, payload);
      else await api.post(`/gyms/${business.id}/packages`, payload);
      toast.success(t('common.saved'));
      setPack(null);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const savePlan = async () => {
    setBusy(true);
    try {
      const payload = {
        nameAr: plan.nameAr,
        kind: plan.kind,
        price: Number(plan.price),
        durationDays: Number(plan.durationDays),
        isActive: true,
        ...(plan.sessionsIncluded ? { sessionsIncluded: Number(plan.sessionsIncluded) } : {}),
      };
      if (plan.id) await api.put(`/gyms/${business.id}/plans/${plan.id}`, payload);
      else await api.post(`/gyms/${business.id}/plans`, payload);
      toast.success(t('common.saved'));
      setPlan(null);
      onChanged();
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const grantPoints = async () => {
    setBusy(true);
    try {
      await api.post(`/gyms/${business.id}/members/${grant.userId}/points`, {
        points: Number(grant.points),
        note: grant.note || undefined,
      });
      toast.success(t('common.saved'));
      setGrant(null);
      const data = await api.get(`/gyms/${business.id}/members`);
      setMembers(data.items ?? []);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <Loading rows={3} />;

  return (
    <>
      <Panel
        title={t('owner.gym')}
        description={t('gym.howItWorks')}
        action={
          <Button variant="primary" size="sm" busy={busy} onClick={saveSettings}>
            {t('common.save')}
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('gym.pointsPerEntry')}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                value={settings.pointsPerEntry}
                onChange={(e) => setSettings({ ...settings, pointsPerEntry: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('gym.expiryMonths')} hint={`${settings.expiryMonths} ${t('common.months')}`}>
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={60}
                value={settings.expiryMonths}
                onChange={(e) => setSettings({ ...settings, expiryMonths: e.target.value })}
              />
            )}
          </Field>
          <Switch
            checked={settings.allowsPoints}
            label={t('gym.store')}
            onChange={(value) => setSettings({ ...settings, allowsPoints: value })}
          />
          <Switch
            checked={settings.allowsMonthly}
            label={t('gym.monthly')}
            onChange={(value) => setSettings({ ...settings, allowsMonthly: value })}
          />
          <div className="sm:col-span-2">
            <Field label={t('gym.beforeYouStart')}>
              {(props) => (
                <Textarea
                  {...props}
                  value={settings.introAr}
                  onChange={(e) => setSettings({ ...settings, introAr: e.target.value })}
                />
              )}
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title={t('gym.store')}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setPack({ nameAr: '', points: 10, bonusPoints: 0, price: 12 })}
          >
            {t('common.add')}
          </Button>
        }
      >
        {(business.pointPackages ?? []).length === 0 ? (
          <Empty title={t('common.empty')} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            {business.pointPackages.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  setPack({
                    id: item.id,
                    nameAr: item.name.ar,
                    points: item.points,
                    bonusPoints: item.bonusPoints,
                    price: item.price,
                  })
                }
                className="panel p-4 text-start transition-colors hover:bg-ink-high"
              >
                <span className="num block text-xl font-bold" style={{ color: hueOf('gym') }}>
                  {item.totalPoints}
                </span>
                <span className="block text-2xs text-paper-dim">{pick(item.name)}</span>
                <Money amount={item.price} className="mt-1 block text-xs font-bold" />
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={t('gym.monthly')}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setPlan({ nameAr: '', kind: 'monthly', price: 30, durationDays: 30, sessionsIncluded: '' })}
          >
            {t('common.add')}
          </Button>
        }
      >
        {(business.plans ?? []).length === 0 ? (
          <Empty title={t('common.empty')} />
        ) : (
          <div className="flex flex-col gap-2">
            {business.plans.map((item) => (
              <div key={item.id} className="row row-quiet justify-between">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-bold">{pick(item.name)}</span>
                  <span className="num text-2xs text-paper-faint">
                    {item.kind === 'monthly' ? t('gym.monthly') : t('gym.privateTraining')} ·{' '}
                    {item.durationDays} {t('common.days')}
                  </span>
                </span>
                <Money amount={item.price} className="text-xs font-bold" />
                <Button
                  size="sm"
                  onClick={() =>
                    setPlan({
                      id: item.id,
                      nameAr: item.name.ar,
                      kind: item.kind,
                      price: item.price,
                      durationDays: item.durationDays,
                      sessionsIncluded: item.sessionsIncluded ?? '',
                    })
                  }
                >
                  {t('common.edit')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={t('owner.members')}>
        {members.length === 0 ? (
          <Empty title={t('common.empty')} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('gym.balance')}</th>
                  <th>{t('gym.expiresOn')}</th>
                  <th>{t('gym.monthly')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      <span className="font-semibold">{member.fullName}</span>
                      <span className="block text-2xs text-paper-faint">{member.email}</span>
                    </td>
                    <td className="num font-bold">{member.pointsBalance}</td>
                    <td className="num text-2xs text-paper-dim">
                      {member.pointsExpireAt ? formatDate(member.pointsExpireAt, { year: 'numeric' }) : '—'}
                    </td>
                    <td className="num text-2xs text-paper-dim">
                      {member.subscriptionEndsOn ? formatDate(member.subscriptionEndsOn, { year: 'numeric' }) : '—'}
                    </td>
                    <td>
                      <Button size="sm" onClick={() => setGrant({ userId: member.id, points: 1, note: '' })}>
                        {t('owner.grantPoints')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={Boolean(pack)}
        onClose={() => setPack(null)}
        title={t('gym.store')}
        footer={
          <>
            <Button onClick={() => setPack(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!pack?.nameAr} onClick={savePackage}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {pack ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.name')} required>
              {(props) => <Input {...props} value={pack.nameAr} onChange={(e) => setPack({ ...pack, nameAr: e.target.value })} />}
            </Field>
            <Field label={t('gym.points')} required>
              {(props) => (
                <Input {...props} type="number" min={1} value={pack.points} onChange={(e) => setPack({ ...pack, points: e.target.value })} />
              )}
            </Field>
            <Field label={t('gym.bonus')}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={0}
                  value={pack.bonusPoints}
                  onChange={(e) => setPack({ ...pack, bonusPoints: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('common.price')} required>
              {(props) => (
                <Input {...props} type="number" min={0} step="0.01" value={pack.price} onChange={(e) => setPack({ ...pack, price: e.target.value })} />
              )}
            </Field>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(plan)}
        onClose={() => setPlan(null)}
        title={t('gym.monthly')}
        footer={
          <>
            <Button onClick={() => setPlan(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} disabled={!plan?.nameAr} onClick={savePlan}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {plan ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('common.name')} required>
              {(props) => <Input {...props} value={plan.nameAr} onChange={(e) => setPlan({ ...plan, nameAr: e.target.value })} />}
            </Field>
            <Field label={t('owner.kind')}>
              {(props) => (
                <Select {...props} value={plan.kind} onChange={(e) => setPlan({ ...plan, kind: e.target.value })}>
                  <option value="monthly">{t('gym.monthly')}</option>
                  <option value="private_training">{t('gym.privateTraining')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('common.price')} required>
              {(props) => (
                <Input {...props} type="number" min={0} step="0.01" value={plan.price} onChange={(e) => setPlan({ ...plan, price: e.target.value })} />
              )}
            </Field>
            <Field label={t('common.days')}>
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  min={1}
                  value={plan.durationDays}
                  onChange={(e) => setPlan({ ...plan, durationDays: e.target.value })}
                />
              )}
            </Field>
            {plan.kind === 'private_training' ? (
              <Field label={t('gym.sessions')}>
                {(props) => (
                  <Input
                    {...props}
                    type="number"
                    min={1}
                    value={plan.sessionsIncluded}
                    onChange={(e) => setPlan({ ...plan, sessionsIncluded: e.target.value })}
                  />
                )}
              </Field>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(grant)}
        onClose={() => setGrant(null)}
        title={t('owner.grantPoints')}
        footer={
          <>
            <Button onClick={() => setGrant(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" busy={busy} onClick={grantPoints}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        {grant ? (
          <div className="grid gap-4">
            <Field label={t('gym.points')} hint="−/+">
              {(props) => (
                <Input
                  {...props}
                  type="number"
                  value={grant.points}
                  onChange={(e) => setGrant({ ...grant, points: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('common.notes')}>
              {(props) => <Input {...props} value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} />}
            </Field>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------
export default function OwnerConsole({ businessId }) {
  const { t, pick } = useI18n();
  const { businesses, refresh } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const messageFor = useErrorMessage();
  const [activeId, setActiveId] = useState(businessId ?? null);
  const [tab, setTab] = useState('overview');
  const [business, setBusiness] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeId && businesses.length) setActiveId(businesses[0].id);
  }, [businesses, activeId]);

  const load = useCallback(() => {
    if (!activeId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.get(`/businesses/${activeId}`),
      api.get('/me/owner/dashboard').catch(() => ({ businesses: [] })),
    ])
      .then(([detail, dash]) => {
        setBusiness(detail);
        setDashboard(dash.businesses.find((entry) => entry.business.id === activeId) ?? null);
      })
      .catch(() => setBusiness(null))
      .finally(() => setLoading(false));
  }, [activeId]);

  useEffect(load, [load]);

  const createBusiness = async () => {
    setBusy(true);
    try {
      const created = await api.post('/businesses', {
        section: creating.section,
        nameAr: creating.nameAr,
        ...(creating.lat ? { lat: Number(creating.lat), lng: Number(creating.lng) } : {}),
      });
      toast.success(t('common.saved'));
      setCreating(null);
      await refresh();
      setActiveId(created.id);
      navigate(`/manage/${created.id}`);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    try {
      const updated = await api.patch(`/businesses/${business.id}/status`, { isActive: !business.isActive });
      setBusiness({ ...business, isActive: updated.isActive });
      toast.success(t('common.saved'));
    } catch (error) {
      toast.error(messageFor(error));
    }
  };

  const newBusinessButton = (
    <Button
      variant="primary"
      size="sm"
      onClick={() => setCreating({ section: 'barber', nameAr: '', lat: '', lng: '' })}
    >
      {t('owner.newBusiness')}
    </Button>
  );

  if (!businesses.length && !loading) {
    return (
      <>
        <Page>
          <Empty title={t('owner.noBusiness')} body={t('owner.createFirst')} action={newBusinessButton} />
        </Page>
        <CreateDialog
          creating={creating}
          setCreating={setCreating}
          onSave={createBusiness}
          busy={busy}
        />
        <Footer />
      </>
    );
  }

  const section = business?.section;
  const rail = (
    <>
      {businesses.length > 1 ? (
        <Select
          className="mb-2"
          value={activeId ?? ''}
          onChange={(event) => {
            setActiveId(Number(event.target.value));
            setTab('overview');
          }}
          aria-label={t('owner.chooseBusiness')}
        >
          {businesses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name.ar}
            </option>
          ))}
        </Select>
      ) : null}
      {[
        ['overview', t('owner.overview')],
        ['details', t('owner.profile')],
        ['hours', t('owner.hours')],
        ['services', t('owner.services')],
        ['staff', t('owner.staff')],
        ...(section === 'barber' || section === 'salon' ? [['chairs', t('owner.chairs')]] : []),
        ...(section === 'salon' ? [['colors', t('owner.colors')]] : []),
        ...(section === 'sports_field' ? [['fields', t('owner.fields')]] : []),
        ...(section === 'gym' ? [['gym', t('owner.gym')]] : []),
        ['diary', t('owner.diary')],
      ].map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="rail-link"
          aria-current={tab === key}
          onClick={() => setTab(key)}
        >
          {label}
        </button>
      ))}
    </>
  );

  return (
    <>
      <Console
        subtitle={t('owner.console')}
        title={business ? pick(business.name) : t('common.loading')}
        rail={rail}
        aside={newBusinessButton}
      >
        {loading || !business ? (
          <Loading rows={5} />
        ) : (
          <div style={accent(section)}>
            {!business.isActive ? (
              <div className="mb-4 rounded-panel border border-warn/40 bg-warn/10 px-4 py-3 text-2xs">
                {t('owner.publishedHidden')}
              </div>
            ) : null}

            {tab === 'overview' ? (
              <>
                <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label={t('owner.todayBookings')} value={dashboard?.todayBookings ?? 0} />
                  <Stat label={t('owner.upcoming')} value={dashboard?.upcomingBookings ?? 0} />
                  <Stat
                    label={t('owner.revenue')}
                    value={(dashboard?.revenuePaid ?? 0).toFixed(2)}
                    note={t('common.currency')}
                    tone="good"
                  />
                  <Stat label={t('common.reviews')} value={dashboard?.reviewCount ?? 0} />
                </div>
                {section === 'sports_field' ? (
                  <div className="mb-5 grid gap-3 sm:grid-cols-2">
                    <Stat label={t('owner.openSessions')} value={dashboard?.openSessions ?? 0} />
                    <Stat label={t('owner.confirmedSessions')} value={dashboard?.confirmedSessions ?? 0} />
                  </div>
                ) : null}
                {section === 'gym' ? (
                  <div className="mb-5 grid gap-3 sm:grid-cols-2">
                    <Stat label={t('owner.activeSubs')} value={dashboard?.activeSubscriptions ?? 0} />
                    <Stat label={t('owner.pointsOut')} value={dashboard?.pointsOutstanding ?? 0} />
                  </div>
                ) : null}
                <Panel title={t('owner.visible')}>
                  <Switch
                    checked={business.isActive}
                    label={business.isActive ? t('common.enabled') : t('common.disabled')}
                    onChange={toggleActive}
                  />
                </Panel>
              </>
            ) : null}

            {tab === 'details' ? <DetailsPanel business={business} onSaved={load} /> : null}
            {tab === 'hours' ? <HoursPanel business={business} onSaved={load} /> : null}
            {tab === 'services' ? <ServicesPanel business={business} onChanged={load} /> : null}
            {tab === 'staff' ? <StaffPanel business={business} onChanged={load} /> : null}
            {tab === 'chairs' ? <ChairsPanel business={business} onChanged={load} /> : null}
            {tab === 'colors' ? <NailColorsPanel business={business} onChanged={load} /> : null}
            {tab === 'fields' ? <FieldsPanel business={business} /> : null}
            {tab === 'gym' ? <GymPanel business={business} onChanged={load} /> : null}
            {tab === 'diary' ? <DiaryPanel business={business} /> : null}
          </div>
        )}
      </Console>
      <CreateDialog creating={creating} setCreating={setCreating} onSave={createBusiness} busy={busy} />
      <Footer />
    </>
  );
}

function CreateDialog({ creating, setCreating, onSave, busy }) {
  const { t } = useI18n();
  const needsLocation = creating?.section === 'gym';
  return (
    <Modal
      open={Boolean(creating)}
      onClose={() => setCreating(null)}
      title={t('owner.newBusiness')}
      footer={
        <>
          <Button onClick={() => setCreating(null)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!creating?.nameAr || (needsLocation && (!creating.lat || !creating.lng))}
            onClick={onSave}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      {creating ? (
        <div className="grid gap-4">
          <Field label={t('owner.kind')} required>
            {(props) => (
              <Select
                {...props}
                value={creating.section}
                onChange={(event) => setCreating({ ...creating, section: event.target.value })}
              >
                {SECTIONS.map((section) => (
                  <option key={section} value={section}>
                    {t(`section.${section}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('common.name')} required>
            {(props) => (
              <Input
                {...props}
                value={creating.nameAr}
                onChange={(event) => setCreating({ ...creating, nameAr: event.target.value })}
              />
            )}
          </Field>
          {needsLocation ? (
            <>
              <p className="hint">{t('error.location_required')}</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Latitude" required>
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="decimal"
                      value={creating.lat}
                      onChange={(event) => setCreating({ ...creating, lat: event.target.value })}
                    />
                  )}
                </Field>
                <Field label="Longitude" required>
                  {(props) => (
                    <Input
                      {...props}
                      inputMode="decimal"
                      value={creating.lng}
                      onChange={(event) => setCreating({ ...creating, lng: event.target.value })}
                    />
                  )}
                </Field>
              </div>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const position = await requestLocation();
                    setCreating({ ...creating, lat: position.lat, lng: position.lng });
                  } catch {
                    /* the person can type the coordinates instead */
                  }
                }}
              >
                {t('owner.useGps')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
