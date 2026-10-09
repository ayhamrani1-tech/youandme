/**
 * Entry point and route table.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from './i18n.jsx';
import { AuthProvider, useAuth } from './auth.jsx';
import { RouterProvider, Routes, Link, useRouter } from './router.jsx';
import { ToastProvider, Loading, Button } from './ui/primitives.jsx';
import { TopBar, Page, Footer } from './ui/Layout.jsx';

import Landing from './pages/Landing.jsx';
import SignIn from './pages/SignIn.jsx';
import SignUp from './pages/SignUp.jsx';
import SectionBrowse from './pages/SectionBrowse.jsx';
import BusinessDetail from './pages/BusinessDetail.jsx';
import FieldsBrowse from './pages/FieldsBrowse.jsx';
import FieldSession from './pages/FieldSession.jsx';
import GymsBrowse from './pages/GymsBrowse.jsx';
import GymStore from './pages/GymStore.jsx';
import HowPointsWork from './pages/HowPointsWork.jsx';
import ClientDashboard from './pages/ClientDashboard.jsx';
import OwnerConsole from './pages/OwnerConsole.jsx';
import AdminConsole from './pages/AdminConsole.jsx';

function NotFound() {
  const { t } = useI18n();
  return (
    <>
      <Page>
        <div className="panel flex flex-col items-start gap-4 px-6 py-12">
          <h1 className="text-xl">{t('notFound.title')}</h1>
          <p className="text-xs text-paper-dim">{t('notFound.body')}</p>
          <Link to="/" className="btn btn-primary">
            {t('notFound.home')}
          </Link>
        </div>
      </Page>
      <Footer />
    </>
  );
}

/** Keeps a route behind a sign-in, and optionally behind a role. */
function Protected({ children, roles }) {
  const { user, ready, role } = useAuth();
  const { t } = useI18n();
  const { navigate, pathname } = useRouter();

  if (!ready) {
    return (
      <Page>
        <Loading rows={4} />
      </Page>
    );
  }
  if (!user) {
    return (
      <Page>
        <div className="panel mx-auto flex max-w-md flex-col items-start gap-4 px-6 py-10">
          <h1 className="text-lg">{t('auth.signIn.title')}</h1>
          <p className="text-xs text-paper-dim">{t('error.sign_in_required')}</p>
          <Button
            variant="primary"
            onClick={() => navigate(`/signin?next=${encodeURIComponent(pathname)}`)}
          >
            {t('auth.submitSignIn')}
          </Button>
        </div>
      </Page>
    );
  }
  if (roles && !roles.includes(role) && role !== 'admin') {
    return (
      <Page>
        <div className="panel flex flex-col items-start gap-3 border-s-3 border-s-bad px-6 py-8">
          <h1 className="text-lg">{t('error.not_your_business')}</h1>
          <Link to="/" className="btn btn-ghost">
            {t('notFound.home')}
          </Link>
        </div>
      </Page>
    );
  }
  return children;
}

function App() {
  const { ready } = useAuth();
  return (
    <>
      <TopBar />
      {ready ? (
        <Routes
          fallback={<NotFound />}
          routes={[
            ['/', () => <Landing />],
            ['/signin', () => <SignIn />],
            ['/signup', () => <SignUp />],

            // Sports fields have their own browse shape: sessions, not businesses.
            ['/fields', () => <FieldsBrowse />],
            ['/fields/sessions/:slotId', (p) => <FieldSession slotId={Number(p.slotId)} />],
            ['/fields/:fieldId', (p) => <FieldSession fieldId={Number(p.fieldId)} />],

            // Gyms: nearby search, the point store, and the explainer.
            ['/gyms', () => <GymsBrowse />],
            ['/gyms/how-it-works', () => <HowPointsWork />],
            ['/gyms/:businessId', (p) => <GymStore businessId={Number(p.businessId)} />],

            // Appointment sections share one browse page and one detail page.
            ['/barber', () => <SectionBrowse section="barber" />],
            ['/barber/:businessId', (p) => <BusinessDetail businessId={Number(p.businessId)} section="barber" />],
            ['/salon', () => <SectionBrowse section="salon" />],
            ['/salon/:businessId', (p) => <BusinessDetail businessId={Number(p.businessId)} section="salon" />],
            ['/dental', () => <SectionBrowse section="dental" />],
            ['/dental/:businessId', (p) => <BusinessDetail businessId={Number(p.businessId)} section="dental" />],

            [
              '/dashboard',
              () => (
                <Protected>
                  <ClientDashboard />
                </Protected>
              ),
            ],
            [
              '/manage',
              () => (
                <Protected roles={['owner']}>
                  <OwnerConsole />
                </Protected>
              ),
            ],
            [
              '/manage/:businessId',
              (p) => (
                <Protected roles={['owner']}>
                  <OwnerConsole businessId={Number(p.businessId)} />
                </Protected>
              ),
            ],
            [
              '/admin',
              () => (
                <Protected roles={['admin']}>
                  <AdminConsole />
                </Protected>
              ),
            ],
          ]}
        />
      ) : (
        <Page>
          <Loading rows={4} />
        </Page>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <I18nProvider>
      <RouterProvider>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </RouterProvider>
    </I18nProvider>
  </StrictMode>,
);
