import { LANGUAGES, setLang, useLang, useT } from '../i18n/index.js';

/** English / हिन्दी switch (step 10). Callers hide it with a wrapper, not `className`. */
export default function LanguageSwitch({ className = '' }) {
  const lang = useLang();
  const t = useT();
  return (
    <div className={`inline-flex rounded-[var(--radius-md)] bg-raised p-1 text-small font-semibold ${className}`} role="radiogroup" aria-label={t('lang.label')}>
      {LANGUAGES.map(([code, name]) => (
        <button
          key={code}
          type="button"
          role="radio"
          aria-checked={lang === code}
          lang={code}
          className={`min-h-9 rounded-[var(--radius-sm)] px-3 transition-colors duration-[var(--dur-fast)] ${lang === code ? 'bg-surface text-fg shadow-[var(--shadow-float)]' : 'text-fg-2 hover:text-fg'}`}
          onClick={() => setLang(code)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
