import { useState } from 'react';
import { requestLocation } from '../api.js';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import { Button, Field, Input, Select } from '../ui/primitives.jsx';
import { Page } from '../ui/Layout.jsx';
import { GOVERNORATES, carrierOf, isValidJordanPhone } from '../ui/sections.js';

export default function SignUp() {
  const { t, locale } = useI18n();
  const { signUp } = useAuth();
  const { navigate } = useRouter();
  const messageFor = useErrorMessage();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    password: '',
    phone: '',
    gender: '',
    role: 'client',
    governorate: '',
    city: '',
  });
  const [coords, setCoords] = useState(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const governorate = GOVERNORATES.find((g) => g.ar === form.governorate);
  const carrier = carrierOf(form.phone);

  const useMyLocation = async () => {
    try {
      setCoords(await requestLocation());
    } catch {
      setError(t('error.location_required'));
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setFieldErrors({});

    const problems = {};
    if (!form.gender) problems.gender = t('common.required');
    if (form.phone && !isValidJordanPhone(form.phone)) problems.phone = t('auth.phoneHint');
    if (form.password.length < 8 || !/\d/.test(form.password)) problems.password = t('auth.passwordHint');
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      return;
    }

    setBusy(true);
    try {
      const user = await signUp({
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        gender: form.gender,
        role: form.role,
        locale,
        ...(form.phone ? { phone: form.phone.trim() } : {}),
        ...(form.governorate ? { governorate: form.governorate } : {}),
        ...(form.city ? { city: form.city } : {}),
        ...(coords ?? {}),
      });
      navigate(user.role === 'owner' ? '/manage' : '/dashboard', { replace: true });
    } catch (err) {
      if (err.details?.length) {
        setFieldErrors(
          Object.fromEntries(err.details.map((detail) => [detail.path, detail.message])),
        );
      }
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-2xl">
      <h1 className="mb-6 text-2xl">{t('auth.signUp.title')}</h1>
      <form className="panel flex flex-col gap-5 p-6" onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('auth.fullName')} required error={fieldErrors.fullName}>
            {(props) => (
              <Input {...props} autoComplete="name" value={form.fullName} onChange={set('fullName')} required />
            )}
          </Field>
          <Field label={t('auth.email')} required error={fieldErrors.email}>
            {(props) => (
              <Input
                {...props}
                type="email"
                inputMode="email"
                autoComplete="username"
                value={form.email}
                onChange={set('email')}
                required
              />
            )}
          </Field>
          <Field
            label={t('auth.password')}
            required
            hint={t('auth.passwordHint')}
            error={fieldErrors.password}
          >
            {(props) => (
              <Input
                {...props}
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={set('password')}
                required
              />
            )}
          </Field>
          <Field
            label={t('auth.phone')}
            hint={carrier ? `${t('auth.phoneHint')} — ${carrier}` : t('auth.phoneHint')}
            error={fieldErrors.phone}
          >
            {(props) => (
              <Input
                {...props}
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="0791234567"
                autoComplete="tel"
                value={form.phone}
                onChange={(event) =>
                  setForm({ ...form, phone: event.target.value.replace(/\D/g, '').slice(0, 10) })
                }
              />
            )}
          </Field>

          {/* Gender is required because it gates two sections. Stated plainly. */}
          <Field label={t('auth.gender')} required hint={t('auth.genderHint')} error={fieldErrors.gender}>
            {(props) => (
              <Select {...props} value={form.gender} onChange={set('gender')} required>
                <option value="">—</option>
                <option value="male">{t('auth.male')}</option>
                <option value="female">{t('auth.female')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('auth.accountType')}>
            {(props) => (
              <Select {...props} value={form.role} onChange={set('role')}>
                <option value="client">{t('auth.asClient')}</option>
                <option value="owner">{t('auth.asOwner')}</option>
              </Select>
            )}
          </Field>

          <Field label={t('auth.governorate')}>
            {(props) => (
              <Select
                {...props}
                value={form.governorate}
                onChange={(event) => setForm({ ...form, governorate: event.target.value, city: '' })}
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
              <Select {...props} value={form.city} onChange={set('city')} disabled={!governorate}>
                <option value="">—</option>
                {governorate?.cities.map((city) => (
                  <option key={city} value={city}>
                    {city}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-ink-line pt-4">
          <Button size="sm" onClick={useMyLocation}>
            {coords ? t('auth.locationSaved') : t('auth.useLocation')}
          </Button>
          <span className="hint">{t('auth.locationHint')}</span>
          {coords ? (
            <span className="num chip chip-good">
              {coords.lat.toFixed(3)}, {coords.lng.toFixed(3)}
            </span>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-chip border border-bad/35 bg-bad/10 px-3 py-2 text-2xs text-paper">{error}</p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" busy={busy}>
          {t('auth.submitSignUp')}
        </Button>
        <p className="text-2xs text-paper-dim">
          {t('auth.haveAccount')}{' '}
          <Link to="/signin" className="text-brass underline underline-offset-4">
            {t('nav.signIn')}
          </Link>
        </p>
      </form>
    </Page>
  );
}
