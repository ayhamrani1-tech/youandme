/**
 * Shared interface pieces.
 *
 * Deliberately small: buttons, fields, a modal, a toast queue, a star rating, a
 * quota meter, and the empty/loading/error states. Everything else is composed
 * from these in the pages.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';

// ---------------------------------------------------------------------------
// Buttons and controls
// ---------------------------------------------------------------------------
export function Button({ variant = 'ghost', size, busy, children, className = '', ...rest }) {
  const classes = ['btn', `btn-${variant}`, size === 'sm' && 'btn-sm', size === 'lg' && 'btn-lg', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="animate-spin">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Field({ label, hint, error, required, children }) {
  const id = useId();
  const child =
    typeof children === 'function'
      ? children({ id, 'aria-invalid': error ? 'true' : undefined })
      : children;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span className="text-brass"> *</span> : null}
      </label>
      {typeof children === 'function' ? child : <div>{child}</div>}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Input({ className = '', ...rest }) {
  return <input className={`control ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select className={`control ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className = '', ...rest }) {
  return <textarea className={`control ${className}`} {...rest} />;
}

export function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-paper-dim hover:text-paper transition-colors"
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          checked ? 'bg-brass border-brass' : 'bg-ink border-ink-line'
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
            checked ? 'bg-ink start-[1.125rem]' : 'bg-paper-faint start-0.5'
          }`}
        />
      </span>
      <span className="text-xs font-semibold">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------
export function Stars({ value = 0, count, size = 14, className = '' }) {
  const filled = Math.round(Number(value) * 2) / 2;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} title={`${value} / 5`}>
      <span className="inline-flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((index) => (
          <svg key={index} width={size} height={size} viewBox="0 0 20 20">
            <path
              d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L10 14.9 4.8 17.6l1-5.8L1.6 7.7l5.8-.8z"
              fill={index <= filled ? 'var(--color-brass)' : 'transparent'}
              stroke={index <= filled ? 'var(--color-brass)' : 'var(--color-ink-line)'}
              strokeWidth="1.5"
            />
          </svg>
        ))}
      </span>
      <span className="num text-2xs text-paper-dim">
        {Number(value || 0).toFixed(1)}
        {count !== undefined ? ` (${count})` : ''}
      </span>
    </span>
  );
}

export function StarPicker({ value, onChange, label }) {
  const { t } = useI18n();
  return (
    <div className="field">
      <label>{label}</label>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((index) => (
          <button
            key={index}
            type="button"
            role="radio"
            aria-checked={value === index}
            aria-label={`${index} / 5`}
            onClick={() => onChange(index)}
            className="p-1 transition-transform hover:scale-110"
          >
            <svg width="26" height="26" viewBox="0 0 20 20">
              <path
                d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L10 14.9 4.8 17.6l1-5.8L1.6 7.7l5.8-.8z"
                fill={index <= (value || 0) ? 'var(--color-brass)' : 'transparent'}
                stroke={index <= (value || 0) ? 'var(--color-brass)' : 'var(--color-ink-line)'}
                strokeWidth="1.5"
              />
            </svg>
          </button>
        ))}
      </div>
      <span className="hint">{value ? `${value} / 5` : t('common.rating')}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The quota meter — the one element given real visual weight
// ---------------------------------------------------------------------------
export function QuotaMeter({ joined, required, showLabel = true }) {
  const { t } = useI18n();
  const need = Math.max(0, required - joined);
  const percent = required > 0 ? Math.min(100, (joined / required) * 100) : 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="num text-lg font-bold">
          {joined}
          <span className="text-paper-faint text-sm font-medium">
            {' '}
            {t('quota.of')} {required}
          </span>
        </span>
        {showLabel ? (
          <span className={`text-2xs font-semibold ${need === 0 ? 'text-good' : 'text-paper-dim'}`}>
            {need === 0
              ? t('quota.confirmed')
              : need === 1
                ? t('quota.needOne')
                : `${need} ${t('quota.need')}`}
          </span>
        ) : null}
      </div>
      <div
        className="meter"
        role="progressbar"
        aria-valuenow={joined}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-label={t('quota.players')}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export function Modal({ open, onClose, title, children, footer, wide }) {
  const { t } = useI18n();
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    boxRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal-box"
        style={wide ? { width: 'min(56rem, 100%)' } : undefined}
      >
        <div className="flex items-center justify-between gap-4 border-b border-ink-line px-5 py-4">
          <h3 className="text-base">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-chip px-2 py-1 text-paper-dim transition-colors hover:bg-ink-high hover:text-paper"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-ink-line px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((all) => all.filter((toast) => toast.id !== id)), []);

  const push = useCallback(
    (message, tone = 'good') => {
      const id = Math.random().toString(36).slice(2);
      setToasts((all) => [...all, { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === 'bad' ? 6000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      show: push,
      success: (message) => push(message, 'good'),
      error: (message) => push(message, 'bad'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-100 flex flex-col items-center gap-2 px-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast pointer-events-auto toast-${toast.tone}`}>
            <span
              aria-hidden="true"
              className={`mt-0.5 inline-block size-2 shrink-0 rounded-full ${
                toast.tone === 'bad' ? 'bg-bad' : 'bg-good'
              }`}
            />
            <span className="flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="text-paper-faint transition-colors hover:text-paper"
              aria-label="✕"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function Loading({ rows = 3, className = '' }) {
  return (
    <div className={`flex flex-col gap-3 ${className}`} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton h-16 w-full" />
      ))}
    </div>
  );
}

/** An empty state is an invitation to act, so it takes an action when there is one. */
export function Empty({ title, body, action }) {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="text-base font-bold">{title}</p>
      {body ? <p className="text-xs text-paper-dim">{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorNote({ message, onRetry }) {
  const { t } = useI18n();
  return (
    <div className="panel flex flex-col items-start gap-3 border-s-3 border-s-bad px-5 py-4">
      <p className="text-xs">{message}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------
export function Money({ amount, className = '' }) {
  const { formatMoney } = useI18n();
  return <span className={`num ${className}`}>{formatMoney(amount)}</span>;
}

export function StatusChip({ status }) {
  const { t } = useI18n();
  const tone =
    status === 'completed' || status === 'confirmed' || status === 'active'
      ? 'chip-good'
      : status === 'cancelled' || status === 'no_show' || status === 'expired'
        ? 'chip-bad'
        : status === 'pending' || status === 'open'
          ? 'chip-warn'
          : '';
  return <span className={`chip ${tone}`}>{t(`status.${status}`) || status}</span>;
}

/** A labelled figure. The number is larger than its label, never the reverse. */
export function Stat({ label, value, note, tone }) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="text-2xs text-paper-dim">{label}</p>
      <p
        className={`num mt-1 text-xl font-bold ${
          tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : ''
        }`}
      >
        {value}
      </p>
      {note ? <p className="mt-0.5 text-2xs text-paper-faint">{note}</p> : null}
    </div>
  );
}

export function Pagination({ page, pages, onChange }) {
  const { t } = useI18n();
  if (!pages || pages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 py-4">
      <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {t('common.previous')}
      </Button>
      <span className="num text-2xs text-paper-dim">
        {t('common.page')} {page} {t('common.of')} {pages}
      </span>
      <Button size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        {t('common.next')}
      </Button>
    </div>
  );
}

/** Tabs that read as navigation, not as decorative pills. */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-ink-line" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={`-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-semibold transition-colors ${
            value === tab.key
              ? 'border-brass text-paper'
              : 'border-transparent text-paper-dim hover:text-paper'
          }`}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="num ms-1.5 text-paper-faint">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
