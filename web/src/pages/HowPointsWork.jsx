/**
 * The gym onboarding explainer.
 *
 * The specification asks for this to be available *before* a customer commits,
 * so it is a page of its own, linked from the landing page, the gym list and
 * every gym's store — not a modal that appears once at checkout.
 *
 * The content comes from the API so the stated rules are the rules the server
 * actually enforces, rather than a second copy that can drift.
 */
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { useRouter } from '../router.jsx';
import { Button, Loading } from '../ui/primitives.jsx';
import { PageHead, Footer } from '../ui/Layout.jsx';
import { accent, hueOf } from '../ui/sections.js';

/** A worked example makes the rollover rule concrete. */
function RolloverExample() {
  const { t, locale } = useI18n();
  const steps =
    locale === 'ar'
      ? [
          { when: 'يناير', text: 'تشتري 10 نقاط. تنتهي صلاحيتها في يوليو.', value: '10' },
          { when: 'فبراير — مايو', text: 'تزور النادي وتُخصم النقاط من رصيدك.', value: '4' },
          { when: 'يونيو', text: 'تشحن 25 نقطة قبل انتهاء الرصيد القديم.', value: '29' },
          { when: 'النتيجة', text: 'الأربع نقاط القديمة انضمت للجديدة، والصلاحية صارت ديسمبر.', value: '29' },
        ]
      : [
          { when: 'January', text: 'You buy 10 points. They expire in July.', value: '10' },
          { when: 'February–May', text: 'You visit the gym and points come off your balance.', value: '4' },
          { when: 'June', text: 'You top up 25 points before the old balance lapses.', value: '29' },
          { when: 'Result', text: 'The 4 old points joined the new ones, and the expiry is now December.', value: '29' },
        ];

  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <li key={step.when} className="flex gap-4 py-3">
          <span className="flex flex-col items-center">
            <span
              className="mt-1.5 size-2.5 shrink-0 rounded-full"
              style={{ background: index === steps.length - 1 ? hueOf('gym') : 'var(--color-ink-line)' }}
            />
            {index < steps.length - 1 ? <span className="w-px flex-1 bg-ink-line" /> : null}
          </span>
          <span className="flex flex-1 flex-col gap-0.5 pb-1">
            <span className="text-xs font-bold">{step.when}</span>
            <span className="text-2xs text-paper-dim">{step.text}</span>
          </span>
          <span className="num shrink-0 text-sm font-bold" style={{ color: hueOf('gym') }}>
            {step.value}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function HowPointsWork() {
  const { t, locale } = useI18n();
  const { navigate } = useRouter();
  const [guide, setGuide] = useState(null);

  useEffect(() => {
    api
      .get('/gyms/how-it-works')
      .then(setGuide)
      .catch(() => setGuide(null));
  }, []);

  const text = (item) => (locale === 'ar' ? item.ar : item.en);

  return (
    <>
      <main className="shell py-8" style={accent('gym')}>
        <PageHead
          title={t('gym.howItWorks')}
          description={t('gym.beforeYouStart')}
          actions={
            <Button variant="accent" onClick={() => navigate('/gyms')}>
              {t('section.gym')}
            </Button>
          }
        />

        {!guide ? (
          <Loading rows={3} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
            <section className="flex flex-col gap-3">
              <h2 className="text-lg">{t('gym.chooseHow')}</h2>
              {guide.options.map((option) => (
                <article key={option.key} className="panel flex flex-col gap-2 p-5">
                  <h3 className="text-base">{locale === 'ar' ? option.titleAr : option.titleEn}</h3>
                  <p className="text-xs leading-relaxed text-paper-dim">
                    {locale === 'ar' ? option.bodyAr : option.bodyEn}
                  </p>
                </article>
              ))}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg">{t('gym.pointRules')}</h2>
              <ul className="panel flex flex-col gap-3 p-5">
                {guide.pointRules.map((rule) => (
                  <li key={rule.key} className="flex gap-3 text-xs leading-relaxed">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 size-1.5 shrink-0 rounded-full"
                      style={{ background: hueOf('gym') }}
                    />
                    <span className={rule.key === 'expiry' || rule.key === 'rollover' ? 'text-paper' : 'text-paper-dim'}>
                      {text(rule)}
                    </span>
                  </li>
                ))}
              </ul>

              <h2 className="mt-2 text-lg">{t('gym.worked')}</h2>
              <div className="panel px-5 py-3">
                <RolloverExample />
              </div>
            </section>
          </div>
        )}
      </main>
      <Footer />
    </>
  );
}
