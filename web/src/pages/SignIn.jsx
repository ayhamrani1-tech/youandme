import { useState } from 'react';
import { useI18n, useErrorMessage } from '../i18n.jsx';
import { useAuth } from '../auth.jsx';
import { Link, useRouter } from '../router.jsx';
import { Button, Field, Input } from '../ui/primitives.jsx';
import { Page } from '../ui/Layout.jsx';

export default function SignIn() {
  const { t } = useI18n();
  const { signIn } = useAuth();
  const { navigate, query } = useRouter();
  const messageFor = useErrorMessage();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await signIn(form.email.trim(), form.password);
      const next =
        query.next ||
        (user.role === 'admin' ? '/admin' : user.role === 'owner' ? '/manage' : '/dashboard');
      navigate(next, { replace: true });
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="max-w-md">
      <h1 className="mb-6 text-2xl">{t('auth.signIn.title')}</h1>
      <form className="panel flex flex-col gap-4 p-6" onSubmit={submit} noValidate>
        <Field label={t('auth.email')} required>
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="username"
              inputMode="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          )}
        </Field>
        <Field label={t('auth.password')} required>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              required
            />
          )}
        </Field>
        {error ? (
          <p className="rounded-chip border border-bad/35 bg-bad/10 px-3 py-2 text-2xs text-paper">{error}</p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" busy={busy}>
          {t('auth.submitSignIn')}
        </Button>
        <p className="text-2xs text-paper-dim">
          {t('auth.noAccount')}{' '}
          <Link to="/signup" className="text-brass underline underline-offset-4">
            {t('nav.signUp')}
          </Link>
        </p>
      </form>
    </Page>
  );
}
