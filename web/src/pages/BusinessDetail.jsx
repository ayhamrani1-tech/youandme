/**
 * A business page and its booking panel.
 *
 * One panel serves three sections, showing only what that section actually
 * needs: a chair and a regular/groom choice for the barber, a stylist plus nail
 * scope and exact polish colours for the salon, and a fixed-price procedure for
 * the dental clinic. Times come from the server's availability grid, so a
 * customer can never pick a slot that is closed, taken or already past.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, withQuery } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { useRouter } from '../router.jsx';
import {
  Button,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Modal,
  Money,
  Select,
  Stars,
  useToast,
} from '../ui/primitives.jsx';
import { Page, Footer } from '../ui/Layout.jsx';
import { accent, hueOf } from '../ui/sections.js';

const todayIso = () => new Date().toISOString().slice(0, 10);
/** Booking opens on tomorrow: by evening, today's remaining slots are gone. */
const defaultDate = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

/** A cover image that removes itself rather than leaving a broken frame. */
function Cover({ src, className }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return <img src={src} alt="" loading="lazy" className={className} onError={() => setFailed(true)} />;
}

/** The polish palette, as actual swatches rather than a list of colour names. */
function ColorPalette({ colors, value, onChange, label }) {
  const { pick } = useI18n();
  return (
    <div className="field">
      <label>{label}</label>
      <div className="flex flex-wrap gap-2">
        {colors.map((color) => (
          <button
            key={color.id}
            type="button"
            onClick={() => onChange(value === color.id ? null : color.id)}
            aria-pressed={value === color.id}
            title={pick(color.name)}
            className={`flex items-center gap-2 rounded-chip border px-2.5 py-1.5 text-2xs transition-colors ${
              value === color.id ? 'border-brass bg-ink-high text-paper' : 'border-ink-line text-paper-dim'
            }`}
          >
            <span
              aria-hidden="true"
              className="size-4 rounded-full border border-white/20"
              style={{ background: color.hex }}
            />
            {pick(color.name)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BusinessDetail({ businessId, section }) {
  const { t, pick, formatDate, formatTime, formatMoney } = useI18n();
  const { user, gate } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const messageFor = useErrorMessage();

  const [state, setState] = useState({ loading: true, business: null, error: null });
  const [form, setForm] = useState({
    date: defaultDate(),
    staffId: '',
    chairId: '',
    serviceIds: [],
    bookingType: 'regular',
    nailScope: '',
    handColor: null,
    footColor: null,
    treatmentCode: '',
    paymentMethod: 'cash',
    notes: '',
  });
  const [availability, setAvailability] = useState(null);
  const [slot, setSlot] = useState(null);
  const [booking, setBooking] = useState(null);
  const [busy, setBusy] = useState(false);

  const access = gate(section);

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    api
      .get(`/businesses/${businessId}`)
      .then((business) => setState({ loading: false, business, error: null }))
      .catch((error) => setState({ loading: false, business: null, error }));
  }, [businessId]);

  useEffect(() => {
    if (access.allowed) load();
    else setState({ loading: false, business: null, error: null });
  }, [load, access.allowed]);

  const business = state.business;
  const services = business?.services ?? [];
  const bookable = useMemo(
    () => services.filter((service) => service.kind !== 'product'),
    [services],
  );
  const products = useMemo(() => services.filter((service) => service.kind === 'product'), [services]);

  // The selected services decide how long the appointment runs.
  const chosen = useMemo(
    () => bookable.filter((service) => form.serviceIds.includes(service.id)),
    [bookable, form.serviceIds],
  );
  const duration = chosen.reduce((sum, service) => sum + service.durationMin, 0) || business?.slotMinutes || 30;
  const total = chosen.reduce((sum, service) => sum + service.finalPrice, 0);

  // Re-ask the server for availability whenever anything that affects it changes.
  useEffect(() => {
    if (!business) return undefined;
    let cancelled = false;
    setSlot(null);
    api
      .get(
        withQuery(`/businesses/${businessId}/availability`, {
          date: form.date,
          staffId: form.staffId || undefined,
          chairId: form.chairId || undefined,
          durationMin: duration,
        }),
      )
      .then((data) => {
        if (!cancelled) setAvailability(data);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, business, form.date, form.staffId, form.chairId, duration]);

  const toggleService = (id) =>
    setForm((current) => {
      const selected = current.serviceIds.includes(id);
      const next = {
        ...current,
        serviceIds: selected
          ? current.serviceIds.filter((value) => value !== id)
          : [...current.serviceIds, id],
      };
      // Choosing a nail service implies where the work is done, so the scope
      // follows it rather than leaving the two to disagree.
      const service = bookable.find((item) => item.id === id);
      if (!selected && service?.nailScope) next.nailScope = service.nailScope;
      return next;
    });

  const submit = async () => {
    if (!user) {
      navigate(`/signin?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setBusy(true);
    try {
      const nailColorIds = [];
      if (section === 'salon' && form.nailScope) {
        if (form.handColor && form.nailScope !== 'feet') {
          nailColorIds.push({ nailColorId: form.handColor, placement: 'hands' });
        }
        if (form.footColor && form.nailScope !== 'hands') {
          nailColorIds.push({ nailColorId: form.footColor, placement: 'feet' });
        }
      }
      const payload = {
        businessId,
        startsAt: slot.startsAt,
        durationMin: duration,
        items: form.serviceIds.map((id) => ({ serviceId: id, qty: 1 })),
        paymentMethod: form.paymentMethod,
        ...(form.staffId ? { staffId: Number(form.staffId) } : {}),
        ...(form.chairId ? { chairId: Number(form.chairId) } : {}),
        ...(section === 'barber' ? { bookingType: form.bookingType } : {}),
        ...(section === 'salon' && form.nailScope ? { nailScope: form.nailScope } : {}),
        ...(nailColorIds.length ? { nailColorIds } : {}),
        ...(section === 'dental' ? { treatmentCode: form.treatmentCode } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      };
      const result = await api.post('/bookings', payload);
      setBooking(result);
      toast.success(t('booking.confirmed'));
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  if (!access.allowed) {
    return (
      <>
        <Page>
          <Empty
            title={t(`error.${access.reason}`)}
            action={
              <Button variant="primary" onClick={() => navigate(user ? '/' : '/signin')}>
                {user ? t('notFound.home') : t('auth.submitSignIn')}
              </Button>
            }
          />
        </Page>
        <Footer />
      </>
    );
  }

  if (state.loading) {
    return (
      <Page>
        <Loading rows={5} />
      </Page>
    );
  }
  if (state.error || !business) {
    return (
      <Page>
        <ErrorNote message={messageFor(state.error)} onRetry={load} />
      </Page>
    );
  }

  const canBook =
    slot &&
    (section === 'dental' ? Boolean(form.treatmentCode) : form.serviceIds.length > 0) &&
    !busy;

  return (
    <>
      <main className="shell py-8" style={accent(section)}>
        {/* Header */}
        <header className="mb-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-3">
            <span
              aria-hidden="true"
              className="h-1 w-12 rounded-full"
              style={{ background: hueOf(section) }}
            />
            <h1 className="text-2xl">{pick(business.name)}</h1>
            <div className="flex flex-wrap items-center gap-3">
              {business.rating.count > 0 ? (
                <Stars value={business.rating.avg} count={business.rating.count} size={16} />
              ) : (
                <span className="text-2xs text-paper-faint">{t('common.noReviews')}</span>
              )}
              <span className="num chip">
                {business.opensAt}–{business.closesAt}
              </span>
              {business.city ? <span className="chip">{business.city}</span> : null}
            </div>
            {pick(business.description) ? (
              <p className="text-xs leading-relaxed text-paper-dim">{pick(business.description)}</p>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {business.phone ? (
                <a href={`tel:${business.phone}`} className="btn btn-ghost btn-sm num">
                  {business.phone}
                </a>
              ) : null}
              {business.mapUrl || (business.lat && business.lng) ? (
                <a
                  href={business.mapUrl || `https://www.google.com/maps?q=${business.lat},${business.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost btn-sm"
                >
                  {t('owner.openInMaps')}
                </a>
              ) : null}
            </div>
          </div>
          <Cover src={business.coverUrl} className="h-52 w-full rounded-panel object-cover lg:h-full" />
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          {/* Booking panel */}
          <section className="panel flex flex-col gap-5 p-5">
            <h2 className="text-lg">{t('booking.book')}</h2>

            {/* Barber: regular cut or the groom's package. */}
            {section === 'barber' ? (
              <Field label={t('booking.type')}>
                {(props) => (
                  <div {...props} className="flex gap-2">
                    {['regular', 'groom'].map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={form.bookingType === type}
                        onClick={() => setForm({ ...form, bookingType: type })}
                        className={`flex-1 rounded-chip border px-3 py-2 text-xs font-semibold transition-colors ${
                          form.bookingType === type
                            ? 'border-brass bg-ink-high text-paper'
                            : 'border-ink-line text-paper-dim'
                        }`}
                      >
                        {t(`booking.${type}`)}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            ) : null}

            {/* Dental: the procedure, at the clinic's published price. */}
            {section === 'dental' ? (
              <Field label={t('booking.treatment')} required>
                {(props) => (
                  <div {...props} className="flex flex-col gap-2">
                    {(business.treatments ?? []).map((treatment) => (
                      <button
                        key={treatment.id}
                        type="button"
                        aria-pressed={form.treatmentCode === treatment.treatmentCode}
                        onClick={() =>
                          setForm({
                            ...form,
                            treatmentCode: treatment.treatmentCode,
                            serviceIds: [treatment.id],
                          })
                        }
                        className={`flex items-center justify-between gap-3 rounded-chip border px-3 py-2.5 text-start transition-colors ${
                          form.treatmentCode === treatment.treatmentCode
                            ? 'border-brass bg-ink-high'
                            : 'border-ink-line hover:border-paper-faint'
                        }`}
                      >
                        <span className="text-xs font-semibold">
                          {t(`treatment.${treatment.treatmentCode}`)}
                        </span>
                        <span className="flex items-baseline gap-2">
                          <span className="num text-2xs text-paper-faint">
                            {treatment.durationMin} {t('common.minutes')}
                          </span>
                          <Money amount={treatment.finalPrice} className="text-xs font-bold" />
                        </span>
                      </button>
                    ))}
                    {(business.treatments ?? []).length === 0 ? (
                      <p className="hint">{t('common.empty')}</p>
                    ) : null}
                  </div>
                )}
              </Field>
            ) : (
              /* Barber and salon: pick services from the owner's price list. */
              <Field label={t('booking.chooseService')} required>
                {(props) => (
                  <div {...props} className="flex flex-col gap-2">
                    {bookable
                      .filter((service) =>
                        section === 'barber' && service.bookingType
                          ? service.bookingType === form.bookingType
                          : true,
                      )
                      .map((service) => (
                        <button
                          key={service.id}
                          type="button"
                          aria-pressed={form.serviceIds.includes(service.id)}
                          onClick={() => toggleService(service.id)}
                          className={`flex items-center justify-between gap-3 rounded-chip border px-3 py-2.5 text-start transition-colors ${
                            form.serviceIds.includes(service.id)
                              ? 'border-brass bg-ink-high'
                              : 'border-ink-line hover:border-paper-faint'
                          }`}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-xs font-semibold">{pick(service.name)}</span>
                            {service.description ? (
                              <span className="truncate text-2xs text-paper-faint">{service.description}</span>
                            ) : null}
                          </span>
                          <span className="flex shrink-0 items-baseline gap-2">
                            <span className="num text-2xs text-paper-faint">
                              {service.durationMin} {t('common.minutes')}
                            </span>
                            {service.discountPercent > 0 ? (
                              <span className="num text-2xs text-paper-faint line-through">
                                {service.price.toFixed(2)}
                              </span>
                            ) : null}
                            <Money amount={service.finalPrice} className="text-xs font-bold" />
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </Field>
            )}

            {/* Salon nails: hands, feet or both, then the exact colours. */}
            {section === 'salon' ? (
              <>
                <Field label={t('booking.nailScope')} hint={t('common.optional')}>
                  {(props) => (
                    <div {...props} className="flex gap-2">
                      {['', 'hands', 'feet', 'both'].map((scope) => (
                        <button
                          key={scope || 'none'}
                          type="button"
                          aria-pressed={form.nailScope === scope}
                          onClick={() => setForm({ ...form, nailScope: scope, handColor: null, footColor: null })}
                          className={`flex-1 rounded-chip border px-2 py-2 text-2xs font-semibold transition-colors ${
                            form.nailScope === scope
                              ? 'border-brass bg-ink-high text-paper'
                              : 'border-ink-line text-paper-dim'
                          }`}
                        >
                          {scope ? t(`booking.${scope}`) : t('common.none')}
                        </button>
                      ))}
                    </div>
                  )}
                </Field>
                {form.nailScope && (business.nailColors ?? []).length > 0 ? (
                  <div className="flex flex-col gap-4 rounded-panel border border-ink-line p-4">
                    {form.nailScope !== 'feet' ? (
                      <ColorPalette
                        colors={business.nailColors}
                        value={form.handColor}
                        onChange={(id) => setForm({ ...form, handColor: id })}
                        label={t('booking.pickHandColor')}
                      />
                    ) : null}
                    {form.nailScope !== 'hands' ? (
                      <ColorPalette
                        colors={business.nailColors}
                        value={form.footColor}
                        onChange={(id) => setForm({ ...form, footColor: id })}
                        label={t('booking.pickFootColor')}
                      />
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {/* Who, and where they sit. */}
            <div className="grid gap-4 sm:grid-cols-2">
              {(business.staff ?? []).length > 0 ? (
                <Field label={t('booking.chooseStaff')}>
                  {(props) => (
                    <Select
                      {...props}
                      value={form.staffId}
                      onChange={(event) => setForm({ ...form, staffId: event.target.value })}
                    >
                      <option value="">{t('booking.anyStaff')}</option>
                      {business.staff.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                          {member.rating.count > 0 ? ` — ${member.rating.avg.toFixed(1)}★` : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
              {(business.chairs ?? []).length > 0 ? (
                <Field label={t('booking.chooseChair')}>
                  {(props) => (
                    <Select
                      {...props}
                      value={form.chairId}
                      onChange={(event) => setForm({ ...form, chairId: event.target.value })}
                    >
                      <option value="">{t('booking.anyChair')}</option>
                      {business.chairs.map((chair) => (
                        <option key={chair.id} value={chair.id}>
                          {chair.label}
                          {chair.staffName ? ` — ${chair.staffName}` : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>

            {/* When. */}
            <Field label={t('booking.chooseDate')} required>
              {(props) => (
                <Input
                  {...props}
                  type="date"
                  min={todayIso()}
                  value={form.date}
                  onChange={(event) => setForm({ ...form, date: event.target.value })}
                />
              )}
            </Field>

            <div className="field">
              <label>{t('booking.chooseTime')}</label>
              {!availability ? (
                <Loading rows={1} />
              ) : availability.isClosed ? (
                <p className="rounded-chip border border-ink-line px-3 py-3 text-2xs text-paper-dim">
                  {t('booking.closedDay')}
                </p>
              ) : availability.slots.filter((s) => s.available).length === 0 ? (
                <p className="rounded-chip border border-ink-line px-3 py-3 text-2xs text-paper-dim">
                  {t('booking.noSlots')}
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {availability.slots.map((option) => (
                    <button
                      key={option.time}
                      type="button"
                      className="slot"
                      disabled={!option.available}
                      aria-pressed={slot?.time === option.time}
                      onClick={() => setSlot(option)}
                    >
                      {option.time}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('booking.payment')}>
                {(props) => (
                  <Select
                    {...props}
                    value={form.paymentMethod}
                    onChange={(event) => setForm({ ...form, paymentMethod: event.target.value })}
                  >
                    <option value="cash">{t('booking.cash')}</option>
                    <option value="card">{t('booking.card')}</option>
                  </Select>
                )}
              </Field>
              <Field label={t('common.notes')} hint={t('common.optional')}>
                {(props) => (
                  <Input
                    {...props}
                    value={form.notes}
                    onChange={(event) => setForm({ ...form, notes: event.target.value })}
                  />
                )}
              </Field>
            </div>

            {/* Summary, then the action that matches its own label. */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-line pt-4">
              <div>
                <p className="text-2xs text-paper-faint">{t('common.total')}</p>
                <p className="num text-xl font-bold">{formatMoney(total)}</p>
                {slot ? (
                  <p className="num mt-0.5 text-2xs text-paper-dim">
                    {formatDate(slot.startsAt, { weekday: 'long' })} {slot.time} — {duration}{' '}
                    {t('common.minutes')}
                  </p>
                ) : null}
              </div>
              <Button variant="accent" size="lg" busy={busy} disabled={!canBook} onClick={submit}>
                {user ? t('booking.bookNow') : t('auth.submitSignIn')}
              </Button>
            </div>
          </section>

          {/* Side column: products and what other customers said. */}
          <aside className="flex flex-col gap-5">
            {products.length > 0 ? (
              <section className="panel p-5">
                <h2 className="mb-3 text-base">{t('owner.services')}</h2>
                <ul className="flex flex-col gap-2">
                  {products.map((product) => (
                    <li key={product.id} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="truncate">{pick(product.name)}</span>
                      <Money amount={product.finalPrice} className="shrink-0 font-semibold" />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {(business.staff ?? []).length > 0 ? (
              <section className="panel p-5">
                <h2 className="mb-3 text-base">{t('owner.staff')}</h2>
                <ul className="flex flex-col gap-3">
                  {business.staff.map((member) => (
                    <li key={member.id} className="flex items-start justify-between gap-3">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-semibold">{member.name}</span>
                        {member.roleTitle ? (
                          <span className="truncate text-2xs text-paper-faint">{member.roleTitle}</span>
                        ) : null}
                      </span>
                      {member.rating.count > 0 ? (
                        <Stars value={member.rating.avg} count={member.rating.count} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="panel p-5">
              <h2 className="mb-3 text-base">{t('common.rating')}</h2>
              {(business.reviews ?? []).length === 0 ? (
                <p className="text-2xs text-paper-dim">{t('common.noReviews')}</p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {business.reviews.slice(0, 6).map((review) => (
                    <li key={review.id} className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{review.userName}</span>
                        <Stars value={review.rating} />
                      </div>
                      {review.comment ? (
                        <p className="text-2xs leading-relaxed text-paper-dim">{review.comment}</p>
                      ) : null}
                      <span className="num text-2xs text-paper-faint">{formatDate(review.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </main>

      {/* Confirmation */}
      <Modal
        open={Boolean(booking)}
        onClose={() => setBooking(null)}
        title={t('booking.confirmed')}
        footer={
          <>
            <Button onClick={() => setBooking(null)}>{t('common.close')}</Button>
            <Button variant="primary" onClick={() => navigate('/dashboard')}>
              {t('nav.dashboard')}
            </Button>
          </>
        }
      >
        {booking ? (
          <div className="flex flex-col gap-3 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-paper-dim">{t('booking.reference')}</span>
              <span className="num font-bold">{booking.booking.reference}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-paper-dim">{t('common.date')}</span>
              <span className="num">
                {formatDate(booking.booking.startsAt, { weekday: 'long' })}{' '}
                {formatTime(booking.booking.startsAt)}
              </span>
            </div>
            {booking.booking.staffName ? (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-paper-dim">{t('booking.withStaff')}</span>
                <span>{booking.booking.staffName}</span>
              </div>
            ) : null}
            {booking.booking.chairLabel ? (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-paper-dim">{t('owner.chairs')}</span>
                <span>{booking.booking.chairLabel}</span>
              </div>
            ) : null}
            {booking.colours?.length ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-paper-dim">{t('booking.nailColors')}</span>
                <span className="flex gap-2">
                  {booking.colours.map((colour, index) => (
                    <span key={index} className="flex items-center gap-1.5 text-2xs">
                      <span
                        aria-hidden="true"
                        className="size-3.5 rounded-full border border-white/20"
                        style={{ background: colour.hex_code }}
                      />
                      {t(`booking.${colour.placement}`)}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3 border-t border-ink-line pt-3">
              <span className="text-paper-dim">{t('common.total')}</span>
              <Money amount={booking.booking.totalAmount} className="text-base font-bold" />
            </div>
            <p className="hint">{t('review.afterOnly')}</p>
          </div>
        ) : null}
      </Modal>
      <Footer />
    </>
  );
}
